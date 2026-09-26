import { getNftMetadata, nftExampleAddress } from "./src/nft.ts";

const result = await getNftMetadata("ethereum-mainnet", nftExampleAddress);
console.log(JSON.stringify({
  chainNetwork: result.chainNetwork,
  contractAddress: result.contractAddress,
  name: result.name,
  symbol: result.symbol,
  tokenType: result.tokenType,
  supportsERC721: result.supportsERC721,
}));
