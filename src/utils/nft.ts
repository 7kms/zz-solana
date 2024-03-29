/**
 * This file refers to metaplex/js and encapsulats the @metaplex-foundation.
 * We don't send the transction immediately in our logical, so we can't use the metaplex/js directly.
 */
import { PublicKey, Connection, Keypair, Transaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Metadata,
  createCreateMasterEditionV3Instruction,
  DataV2,
  Creator,
  createCreateMetadataAccountV2Instruction,
  createVerifyCollectionInstruction,
  createUpdateMetadataAccountV2Instruction,
  createBurnNftInstruction,
  BurnNftInstructionAccounts,
} from '@metaplex-foundation/mpl-token-metadata';
import {
  findMetadataPda,
  findMasterEditionV2Pda,
  findAssociatedTokenAccountPda,
} from '@metaplex-foundation/js';

import { getCreateMintTx, getMintToTx } from './public';

// metadata, see: https://docs.metaplex.com/programs/token-metadata/accounts#metadata
export declare type MetadataJson = {
  name: string;
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: number;
  creators: {
    address: string;
    share: number;
  }[];
  collection?: {
    verified: boolean;
    key: string;
  };
};

export interface MintNFTParams {
  connection: Connection;
  wallet: Keypair;
  uri: string;
  maxSupply?: number;
}

export interface MintNFTResponse {
  txId: string;
  mint: PublicKey;
  metadata: PublicKey;
  edition: PublicKey;
}

interface MintTxs {
  recipient: PublicKey;
  createMintTx: Transaction;
  createAssociatedTokenAccountTx: Transaction;
  mintToTx: Transaction;
}

export const prepareTokenAccountAndMintTxs = async (
  connection: Connection,
  owner: PublicKey,
  payer: Keypair,
  mint: Keypair,
): Promise<MintTxs> => {
  const createMintTx = await getCreateMintTx(
    connection,
    payer,
    payer.publicKey,
    payer.publicKey,
    0,
    mint,
  );
  const recipient = await getAssociatedTokenAddress(mint.publicKey, owner);
  const createAssociatedTokenAccountTx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      recipient,
      owner,
      mint.publicKey,
    ),
  );
  const mintToTx = getMintToTx(mint.publicKey, recipient, payer.publicKey, 1);
  return {
    createMintTx,
    createAssociatedTokenAccountTx,
    mintToTx,
    recipient,
  };
};

/**
 * Get all txs for mint a nft
 * @param connection
 * @param payer tx payer
 * @param owner nft owenr
 * @param metaJSON metadata
 * @param mint Keypair of the nft which will be minted
 * @returns
 */
export const getNFTMintTxs = async (
  connection: Connection,
  payer: Keypair,
  owner: PublicKey,
  metaJSON: MetadataJson,
  mint: Keypair,
) => {
  const txs: Transaction[] = [];
  const { createMintTx, createAssociatedTokenAccountTx, mintToTx } =
    await prepareTokenAccountAndMintTxs(connection, owner, payer, mint);

  const metadataPDA = findMetadataPda(mint.publicKey);
  const editionPDA = findMasterEditionV2Pda(mint.publicKey);

  const { name, symbol, uri, sellerFeeBasisPoints, creators, collection } =
    metaJSON;

  const creatorsData = creators.reduce<Creator[]>(
    (memo, { address, share }) => {
      const verified = address === owner.toString();

      const creator: Creator = {
        address: new PublicKey(address),
        share,
        verified,
      };

      memo = [...memo, creator];

      return memo;
    },
    [],
  );

  // 1. metadata
  const metadataData: DataV2 = {
    name,
    symbol,
    uri,
    sellerFeeBasisPoints,
    creators: creatorsData,
    collection: collection
      ? {
          verified: false,
          key: new PublicKey(collection.key),
        }
      : null,
    uses: null,
  };
  const createMetadataTx = new Transaction().add(
    createCreateMetadataAccountV2Instruction(
      {
        metadata: metadataPDA,
        mint: mint.publicKey,
        mintAuthority: payer.publicKey,
        payer: payer.publicKey,
        updateAuthority: payer.publicKey,
      },
      {
        createMetadataAccountArgsV2: {
          data: metadataData,
          isMutable: true,
        },
      },
    ),
  );

  // 2. master edition
  const masterEditionTx = new Transaction().add(
    createCreateMasterEditionV3Instruction(
      {
        edition: editionPDA,
        mint: mint.publicKey,
        updateAuthority: payer.publicKey,
        mintAuthority: payer.publicKey,
        payer: payer.publicKey,
        metadata: metadataPDA,
      },
      {
        createMasterEditionArgs: {
          maxSupply: 0,
        },
      },
    ),
  );
  txs.push(
    ...[
      createMintTx,
      createMetadataTx,
      createAssociatedTokenAccountTx,
      mintToTx,
      masterEditionTx,
    ],
  );

  // 3. collection verify
  if (metadataData.collection) {
    const collectionPDA = findMetadataPda(metadataData.collection.key);
    const collectioMasterEditionPDA = findMasterEditionV2Pda(
      metadataData.collection.key,
    );
    const verifyCollectionTx = new Transaction().add(
      createVerifyCollectionInstruction({
        metadata: metadataPDA,
        collectionAuthority: payer.publicKey,
        payer: payer.publicKey,
        collectionMint: metadataData.collection.key,
        collection: collectionPDA,
        collectionMasterEditionAccount: collectioMasterEditionPDA,
      }),
    );
    txs.push(verifyCollectionTx);
  }

  return txs;
};

/**
 * Get update metada txs
 * @param author
 * @param nftAddress
 * @param metaJSON
 * @returns
 */
export const getUpdateMetadataTx = (
  author: PublicKey,
  nftAddress: PublicKey,
  metaJSON: MetadataJson,
) => {
  const metadataPDA = findMetadataPda(nftAddress);

  // 1. metadata
  const { name, symbol, uri, sellerFeeBasisPoints, creators, collection } =
    metaJSON;

  const creatorsData = creators.reduce<Creator[]>(
    (memo, { address, share }) => {
      const verified = address === author.toString();

      const creator: Creator = {
        address: new PublicKey(address),
        share,
        verified,
      };

      memo = [...memo, creator];

      return memo;
    },
    [],
  );

  const metadataData: DataV2 = {
    name,
    symbol,
    uri,
    sellerFeeBasisPoints,
    creators: creatorsData,
    collection: collection
      ? {
          verified: true,
          key: new PublicKey(collection.key),
        }
      : null,
    uses: null,
  };

  const updataMetadataTx = new Transaction().add(
    createUpdateMetadataAccountV2Instruction(
      {
        metadata: metadataPDA,

        updateAuthority: author,
      },
      {
        updateMetadataAccountArgsV2: {
          data: metadataData,
          updateAuthority: author,
          primarySaleHappened: false,
          isMutable: true,
        },
      },
    ),
  );

  return updataMetadataTx;
};

export const getNFTBurnTxs = async (
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
) => {
  const metadataPDA = findMetadataPda(mint);
  const masterEditionPDA = findMasterEditionV2Pda(mint);
  const nftMetadata = await getMetadata(connection, mint);
  const collectionPDA = nftMetadata.collection
    ? findMetadataPda(nftMetadata.collection.key)
    : undefined;

  const associatedTokenAccount = await getAssociatedTokenAddress(mint, owner);
  const targetAccounts: BurnNftInstructionAccounts = {
    metadata: metadataPDA,
    owner,
    mint,
    tokenAccount: associatedTokenAccount,
    masterEditionAccount: masterEditionPDA,
    splTokenProgram: TOKEN_PROGRAM_ID,
    collectionMetadata: collectionPDA,
  };
  const burnNFTTx = new Transaction().add(
    createBurnNftInstruction(targetAccounts),
  );
  return burnNFTTx;
};

/**
 * Get metadata from a mint address
 * @param connection
 * @param nftAddress
 * @returns
 */
export const getMetadata = async (
  connection: Connection,
  nftAddress: PublicKey,
) => {
  return (
    await Metadata.fromAccountAddress(connection, findMetadataPda(nftAddress))
  ).pretty();
};
