#!/usr/bin/env node
// Sets the agentURI of Charter's ERC-8004 listing on Base: one `setAgentURI(agentId, newURI)` call from the
// identity key. Sending the address it already has is allowed and useful: the registry emits its update event,
// which is what makes directories read the registration file again after it changed.
//   node deploy/identity/set-uri.mjs <key file> <agentId> <https agentURI> [--dry-run]
// Run it in the door image like register.mjs:
//   docker run --rm -v /opt/charter/deploy/identity/set-uri.mjs:/app/set-uri.mjs:ro \
//     -v /root/charter-identity/secrets:/secrets:ro charter-door:local \
//     node set-uri.mjs /secrets/identity.key 1229952 https://charterhome.dev/.well-known/agent-registration.json
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, formatEther, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const abi = parseAbi([
  'function setAgentURI(uint256 agentId, string newURI)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
]);

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const [keyFile, id, agentURI] = args.filter((a) => !a.startsWith('--'));
if (!keyFile || !/^\d+$/.test(id ?? '') || !/^https:\/\//.test(agentURI ?? '')) {
  console.error('usage: set-uri.mjs <key file> <agentId> <https agentURI> [--dry-run]');
  process.exit(2);
}
const agentId = BigInt(id);

const account = privateKeyToAccount(readFileSync(keyFile, 'utf8').trim());
const transport = http(process.env.BASE_RPC_URL || 'https://base-rpc.publicnode.com');
const pub = createPublicClient({ chain: base, transport });
const wallet = createWalletClient({ account, chain: base, transport });

const owner = await pub.readContract({ address: REGISTRY, abi, functionName: 'ownerOf', args: [agentId] });
if (owner.toLowerCase() !== account.address.toLowerCase()) {
  console.error(`agent ${agentId} is owned by ${owner}, not by this key (${account.address})`);
  process.exit(1);
}
console.log(`uri before ${await pub.readContract({ address: REGISTRY, abi, functionName: 'tokenURI', args: [agentId] })}`);

const call = { address: REGISTRY, abi, functionName: 'setAgentURI', args: [agentId, agentURI], account };
const { request } = await pub.simulateContract(call);
const cost = (await pub.estimateContractGas(call)) * (await pub.getGasPrice());
const balance = await pub.getBalance({ address: account.address });
console.log(`owner ${account.address}  balance ${formatEther(balance)} ETH  estimated gas ${formatEther(cost)} ETH`);
if (balance < cost * 3n) {
  console.error('balance is under three times the estimate; fund the owner address first');
  process.exit(1);
}
if (dry) process.exit(0);

const hash = await wallet.writeContract(request);
console.log(`sent ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
if (receipt.status !== 'success') {
  console.error(`transaction ${hash} reverted`);
  process.exit(1);
}
console.log(`block ${receipt.blockNumber}  events from the registry ${receipt.logs.filter((l) => l.address.toLowerCase() === REGISTRY.toLowerCase()).length}`);
console.log(`uri after ${await pub.readContract({ address: REGISTRY, abi, functionName: 'tokenURI', args: [agentId] })}`);
