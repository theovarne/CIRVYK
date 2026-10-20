/** Website identity only. Token identity and observation configuration are separate. */
export const BRAND_NAME = 'CIRVYK';
export function pageTitle(page = 'home') {
  const label = { live: 'Live', circuit: 'Core', memory: 'Memory', source: 'Source', workbench: 'Workbench', protocol: 'Protocol' }[page];
  return label ? `${label} | ${BRAND_NAME}` : BRAND_NAME;
}
export const SITE = Object.freeze({
  brand: { name: BRAND_NAME, workingTitle: false, mechanism: 'Deterministic signal system', version: 'V1.1', icon: '/assets/circuit-icon.svg', description: 'A circuit shaped by its own market. On-chain activity becomes signals, paths and replayable memory.' },
  token: { name: null, ticker: null, mint: null, network: 'mainnet-beta' },
  links: { social: [{ name: 'X', url: 'https://x.com/CIRVYK' }, { name: 'GitHub', url: 'https://github.com/theovarne/CIRVYK' }], trade: null, explorer: 'https://explorer.solana.com' },
  observation: { source: 'Solana JSON-RPC', pollMs: 15000, accounts: [], retainedInputs: 4000 },
  canonical: 'https://circuit-living-v11.vercel.app',
});
