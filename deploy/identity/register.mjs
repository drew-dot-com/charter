#!/usr/bin/env node
// Registers Charter in the ERC-8004 identity registry on Base: one `register(agentURI)` call from the
// identity key, which then owns the listing (an ERC-721 token). Prints the agent id and the transaction
// hash, never the key. Refuses when the key already owns a listing, unless --again is given.
//   node deploy/identity/register.mjs <key file> <agentURI> [--dry-run] [--again]
// The key file is 0x + 64 hex (deploy/door/new-claim-key.mjs makes one). BASE_RPC_URL picks the RPC.
// The door image has viem; run it there with this file mounted into /app:
//   docker run --rm -v /opt/charter/deploy/identity/register.mjs:/app/register.mjs:ro \
//     -v /root/charter-identity/secrets:/secrets:ro charter-door:local \
//     node register.mjs /secrets/identity.key https://charterhome.dev/.well-known/agent-registration.json
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

/** The identity registry's address on Base mainnet (erc-8004/erc-8004-contracts README). */
const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const abi = parseAbi([
  'function register(string agentURI) returns (uint256 agentId)',
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [keyFile, agentURI] = args.filter((a) => !a.startsWith('--'));
if (!keyFile || !agentURI || !/^https:\/\//.test(agentURI)) {
  console.error('usage: register.mjs <key file> <https agentURI> [--dry-run] [--again]');
  process.exit(2);
}

const account = privateKeyToAccount(readFileSync(keyFile, 'utf8').trim());
const transport = http(process.env.BASE_RPC_URL || 'https://base-rpc.publicnode.com');
const pub = createPublicClient({ chain: base, transport });
const wallet = createWalletClient({ account, chain: base, transport });

const held = await pub.readContract({ address: REGISTRY, abi, functionName: 'balanceOf', args: [account.address] });
if (held > 0n && !flags.has('--again')) {
  console.error(`${account.address} already owns ${held} listing(s); pass --again to register another`);
  process.exit(1);
}

const call = { address: REGISTRY, abi, functionName: 'register', args: [agentURI], account };
const { request, result } = await pub.simulateContract(call);
const gas = await pub.estimateContractGas(call);
const cost = gas * (await pub.getGasPrice());
const balance = await pub.getBalance({ address: account.address });
console.log(`owner ${account.address}  balance ${formatEther(balance)} ETH  estimated gas ${formatEther(cost)} ETH`);
console.log(`simulated agent id ${result}`);
if (balance < cost * 3n) {
  console.error('balance is under three times the estimate; fund the owner address first');
  process.exit(1);
}
if (flags.has('--dry-run')) process.exit(0);

const hash = await wallet.writeContract(request);
console.log(`sent ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
if (receipt.status !== 'success') {
  console.error(`transaction ${hash} reverted`);
  process.exit(1);
}
const minted = parseEventLogs({ abi, logs: receipt.logs, eventName: 'Transfer' }).find(
  (l) => l.address.toLowerCase() === REGISTRY.toLowerCase() && l.args.to.toLowerCase() === account.address.toLowerCase(),
);
if (!minted) {
  console.error(`transaction ${hash} succeeded but no mint to ${account.address} was found in its logs`);
  process.exit(1);
}
const agentId = minted.args.tokenId;
console.log(`agent id ${agentId}  block ${receipt.blockNumber}`);
console.log(`owner on chain ${await pub.readContract({ address: REGISTRY, abi, functionName: 'ownerOf', args: [agentId] })}`);
console.log(`uri on chain ${await pub.readContract({ address: REGISTRY, abi, functionName: 'tokenURI', args: [agentId] })}`);
