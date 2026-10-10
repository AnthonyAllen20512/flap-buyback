# Flap Boost Contracts

Standalone, user-funded BNB buybacks. This is **not** a tax-token Vault or
VaultPortal integration. `FlapBoostVaultFactory` creates exactly one
`FlapBoostVault` for each owner and target token. Burn, retain, and fixed-address
distribution are operations inside that Vault; all use the same BNB balance.

## Creation and funding

The Factory exposes three real operation modes:

- `createFixedBNBOperation(options, bnbPerRound)` spends a fixed BNB amount.
- `createFixedTokenAmountOperation(options, tokenAmountPerRound)` derives the
  required BNB from a live Portal quote and the Vault's available balance.
- `createBalancePercentageOperation(options, balanceBps, maxBNBPerRound)` spends a
  percentage of the post-fee shared balance, optionally capped.

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
covers both fees and the reserved buyback budget, and the round is at least 20
times the combined fees (0.006 BNB at a 0.0002 BNB Trigger fee). Each later
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

## Deployment and tests

Run `forge test` before deployment. The Foundry suite covers shared Vault
identity, per-booking fee, combined funding and first direct execution, the three buy modes,
funding order, refund timing, reservation safety, closure, and swap retry.

Use `script/testnet/bnb/DeployFlapBoostTestnet.s.sol` to deploy the Factory
on BSC testnet.
Current testnet Factory (chain 97): `0x095814ef73e8cdd740ecadd604b61370e3d5343f`
([deployment transaction](https://testnet.bscscan.com/tx/0x24d541408ea7b68555f9ccbffc5c37e5909a775cab87568c68bfc9c8cf956801)).
This deployment creates Vaults with the per-booking fee and combined-fee guard.
Set `FLAP_BOOST_DEPLOYER_PRIVATE_KEY` only in a trusted local environment; do
not put it in scripts, source files, or chat logs. Update the mini-app manifest
binding to the verified Factory address after deployment.

The current Factory-scoped non-tax Mini App surface is for local integration
testing; its Flap artifact manifest needs a supported production binding mode
before submission to the Flap Workbench.
