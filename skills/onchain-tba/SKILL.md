---
name: onchain-tba
description: >-
  TBA inventory rules for StonkBroker: buys fund from TBA, EOA pays gas only.
  Use when preparing swaps, funding wallets, or debugging path/fundedBy.
priority: 5
inject: thesis
---

# On-chain TBA sleeve

This agent manages a **Tokenbound Account** behind a StonkBroker NFT on Robinhood Chain — not a CEX account.

## Agent rules

1. Buys spend **TBA** WETH/ETH — fund the TBA; EOA pays **gas only**.
2. Never send TBA proceeds / inventory to the owner EOA as part of a trade path.
3. Prefer Uniswap v4 UniversalRouter; V3 is fallback. **Refuse** if exec quote is >5% below independent mark.
4. Dry run ON by default; Live feed must show thesis, plan, fee pass/fail.
5. Activation clears on transfer; liquid contents removable until sale — size risk accordingly.
6. Stock tokens are **geo-restricted**; not financial advice; no profit guarantee.
7. Never use Rail A (`robinhood-trading` MCP) `place_*` for TBA management.
