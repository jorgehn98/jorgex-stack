# Choosing Valuable Tests

## Discover the real contract and command

Before writing or selecting a test, read the complete relevant contract across the implementation, public API, documentation, configuration, and existing tests. Identify the runner, script or command, setup, and path/filter scope that the repository actually uses, then choose the narrowest command that exercises the contract. Preserve a minimal independent control case when the contract includes both boundary and normal examples. Follow the project's documented direct command rather than substituting a familiar package-manager wrapper; if the command would install or prompt, stop and report the constraint. Reuse the project's existing tooling and setup; do not auto-install a runner, framework, polyfill, or package, and do not assume a particular language ecosystem. If the suite or infrastructure required by the risk is unavailable, propose the missing protection or state the limitation instead of calling it a no-test decision.

## Deterministic evidence

Control the sources that can change the result—clock and timezone, random IDs, ordering, process/global state, filesystem, and network—only when relevant. Use isolated temporary fixtures and cleanup; never rely on HOME, user data, or a live service by accident. Assert expected errors at the narrow boundary that owns them, while leaving unexpected output and teardown failures visible. Keep the first failure and any bounded diagnostic repetitions when investigating flakiness; retries to obtain green or timeout inflation without a diagnosed cause are not evidence.

## One behavior, one authoritative seam

Choose the seam from the regression you need to catch.

```typescript
// Pure pricing rule: a focused module test is closest to the risk.
test("applies the reduced tax rate to eligible items", () => {
  expect(calculateTax(eligibleItem)).toBe(4.2);
});
```

```typescript
// User interaction: verify the accessible outcome, not DOM decoration.
test("submits a valid checkout", async () => {
  await user.click(screen.getByRole("button", { name: "Pay" }));
  expect(await screen.findByText("Payment confirmed")).toBeVisible();
});
```

```sql
-- Tenant isolation: execute against a real test database with two users.
-- Regex matching a CREATE POLICY statement does not prove RLS behavior.
```

Characteristics of valuable tests:

- Catch a concrete user, business, security, data, or contract regression
- Observe a public interface or the real boundary at risk
- Survive an internal refactor
- Use the narrowest reliable setup
- Add a second layer only for a different contract

## Low-value and redundant tests

Avoid tests whose only purpose is to assert:

- Tailwind classes, decorative DOM, or incidental markup
- That a wrapper, alias, constant, callback, or function exists
- Exact internal call counts/order when the observable result is what matters
- The same behavior already protected at a stronger seam
- SQL policy or migration correctness exclusively through text/regex shape
- “Integration” while every important collaborator is mocked

```typescript
// BAD: locks internal choreography.
expect(paymentService.charge).toHaveBeenCalledTimes(1);
expect(emailService.send).toHaveBeenCalledAfter(paymentService.charge);

// BETTER: assert the contract callers rely on.
expect(result).toMatchObject({ status: "confirmed", receiptId: expect.any(String) });
```

Exact calls are valid only when the call itself is the external contract—for example, the precise payload sent to a payment provider or an idempotency key required by its protocol.

## Valid no-new-test decisions

A change may need no new test when it is styling-only, mechanical, generated, already covered by an authoritative test, or has no meaningful behavioral branch. State the reason and run the cheapest existing verification that could catch an accidental break.
