# Boundary Doubles and Mocks

Mocks are a cost/risk tradeoff, not a goal or a categorical ban.

## Prefer real behavior when practical

Use real owned code when it is fast, deterministic, safe, and easy to set up. Mocking internal collaborators just to assert call choreography couples the test to implementation and can let broken behavior pass.

Prefer real test infrastructure when the risk lives there:

- RLS, SQL, migrations, transactions, and data-transaction atomicity → test database
- Other concurrency or atomicity → the actual filesystem, queue, process, or shared-state boundary
- Filesystem semantics → isolated temp directory
- Serialization/protocol parsing → real encoder/decoder

## Use a boundary double when it is the reliable seam

A fake, stub, or mock is appropriate for a boundary that is unavailable, expensive, nondeterministic, destructive, or controlled by a third party:

- Payment, email, identity, or other external APIs
- Time, randomness, process execution, or network failures
- A slow service when its protocol—not its implementation—is the contract under test

Assert only the boundary contract needed by the behavior: payload, headers, idempotency key, returned error mapping, or observable result. Avoid exhaustive call counts and ordering unless the external protocol requires them.

## Keep doubles simple

- Inject the narrow boundary instead of mocking a large internal module graph.
- Return one explicit shape per scenario.
- Do not rebuild production branching logic inside the mock.
- If every important collaborator is mocked, do not call the suite integration testing.
- Prefer a reusable fake only after repeated real need; do not create abstraction for a single test.

The question is not “can this be mocked?” It is “which setup gives the strongest evidence for this risk at acceptable cost?”
