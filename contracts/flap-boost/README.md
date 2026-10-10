# Flap Boost Contracts

Standalone, user-funded BNB buybacks. This is **not** a tax-token Vault or
VaultPortal integration. `FlapBoostVaultFactory` creates exactly one
`FlapBoostVault` for each owner and target token within that Factory. All
operations in a Vault use the same BNB balance. On the new testnet Factory,
one round can split bought tokens between burn, retention and distribution.

## Creation and funding

The Factory exposes three buy amount modes and a split-output creation entry:

- `createFixedBNBOperation(options, bnbPerRound)` spends a fixed BNB amount.
- `createFixedTokenAmountOperation(options, tokenAmountPerRound)` derives the
  required BNB from a live Portal quote and the Vault's available balance.
- `createBalancePercentageOperation(options, balanceBps, maxBNBPerRound)` spends a
  percentage of the post-fee shared balance, optionally capped.
- `createSplitOperation(options, mode, amount, balanceBps, maxBNBPerRound, splitBps)`
  buys once and distributes the received tokens according to three shares.
  In output mode 5 the shares are burn, retain to one specified wallet, and
  distribute to either one to five fixed recipients or one to twenty generated
  addresses. Output mode 4 retains the prior burn/fixed/generated interpretation.
  Shares are basis points and must total 10,000.

The generated addresses are not actual token holders and have no usable private
keys. Tokens sent to them are effectively unrecoverable. Rounding dust goes to
the generated-address share when selected, otherwise the fixed-address share,
otherwise burn in mode 4. In mode 5, dust goes to distribution when selected,
otherwise retention, otherwise burn. Split rules can be edited with
`updateSplitOperation`; a change
to an already-booked round takes effect after that round completes.

All modes require `minTokensPerBNB`, a per-operation absolute price floor. This
is not a same-transaction spot slippage setting. The Factory returns the shared
Vault address and the operation ID. `vaultOf(owner, token)` and `vaultsOf(owner)`
expose discovery; `getOperation(id)` returns the rules and results.

Anyone can send BNB to `fund()` or `receive()`. Only the owner can start,
update, pause, resume, close an operation, or withdraw unreserved BNB. Donors
must trust the Vault owner: this is not a donation escrow. Closing an operation
does not withdraw the shared pool. A closed operation's reserved round can
remain locked until its already-paid Trigger callback arrives.

The Mini App calls `fundAndTryStart(id)` so the owner's funding transaction
also attempts the first round. If the balance is insufficient, the deposit
stays in the shared Vault; a later top-up tries again. `startOperation(id)`
remains available for BNB already deposited by another route. The first round
executes directly, without a Trigger booking fee. Each successfully booked
automatic request pays the dynamic Trigger fee plus a fixed 0.0001 BNB booking
fee to `0x439CEed9DBA171857e6A0b16705e3880c4ff131e`. A reverted or
zero-ID booking does not charge the fixed booking fee. The Vault schedules only if the shared balance
covers both fees and the reserved buyback budget, and the round is at least 10
times the combined fees (0.003 BNB at a 0.0002 BNB Trigger fee). Each later
successful booking, including a retry after a failed request, pays again. When
the balance is insufficient, no new Trigger is booked; a
later `fund()` or `poke()` retries scheduling.

If the official Trigger reports a request as `FAILED`, the owner can call
`recoverFailedTrigger()` to release its reservation and attempt a fresh booking.
A merely late `PENDING` request cannot be cleared this way: the service does
not guarantee an exact execution time, so clearing it could create two live
requests. The failed request's original Trigger and booking fees are not refunded.

One Trigger queue serves the entire Vault, with at most one outstanding request.
Operations are selected by the earliest `nextEligibleAt` (operation ID breaks
ties). If the earliest operation cannot be funded, it waits for a deposit; a
later operation does not skip ahead. A newly started operation may wait for an
already-booked request before the queue is re-evaluated. Pausing or closing an
unfunded queue head immediately retries scheduling the next eligible operation.
A failed swap uses
exponential backoff. Portal refunds during a callback only increase the pool;
they do not book an early request. Bought tokens that cannot be delivered stay
as pending output and can be retried, including through `settlePendingOutput()`.
If the actual token balance increase is below the required minimum, the swap
is rolled back before recording a failure and scheduling a retry.

`MAX_OPERATIONS` is 24 lifetime operations per Vault, including closed ones,
so a callback does not scan an unbounded list.
The Portal and Trigger dependencies are selected from `block.chainid` for BSC
mainnet 56 or BSC testnet 97; unsupported chains revert.
The Factory deploys a dedicated `FlapBoostVaultDeployer` in its constructor to
keep both runtime bytecodes below the EVM size limit. The deployer can only be
called by its Factory; each Vault still authorizes its Factory for rule creation.

## Deployment and tests

Run `forge test` before deployment. The Foundry suite covers shared Vault
identity, per-booking fee, combined funding and first direct execution, the three buy modes,
funding order, refund timing, reservation safety, closure, and swap retry.

Use `script/testnet/bnb/DeployFlapBoostTestnet.s.sol` to deploy the Factory
on BSC testnet.
Current testnet Factory (chain 97): `0x8501188344c454acb2198518e2ed81e0f8f6381e`
([deployment transaction](https://testnet.bscscan.com/tx/0xba100a12cfcc29d046e69cccd236bd30783d88306c404c5b3049cb5ac85bed35)).
This deployment adds output mode 5: proportional burn, retention to one owner-specified
wallet, and distribution to either 1–5 fixed recipients or generated addresses.
Mode 4 remains unchanged for Vaults created by the previous Factory
`0xF12C19d415b432268e201ea38fd93011F7a306F1`; the mini-app reads both Factory lists.
Set `FLAP_BOOST_DEPLOYER_PRIVATE_KEY` only in a trusted local environment; do
not put it in scripts, source files, or chat logs. Update the mini-app manifest
binding to the verified Factory address after deployment.

The current Factory-scoped non-tax Mini App surface is for local integration
testing; its Flap artifact manifest needs a supported production binding mode
before submission to the Flap Workbench.
