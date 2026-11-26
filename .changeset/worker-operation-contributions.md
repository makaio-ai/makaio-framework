---
"@makaio/contracts": minor
"@makaio/core": minor
"@makaio/framework": minor
"@makaio/runtime-node": minor
---

Extensions can contribute named fixed worker operations. The Node host exposes their active names and phases for workflow checks and uses the same registrations to execute an admitted workflow. A fixed source requires the host's checkout identity, pinned revision and path, and the host verifies the prepared checkout before code runs. Private run directories are retired after confirmed process closure.

Node boot supplies the optional `fixedOperations` runtime port. Existing implementations of the runtime handle remain compatible.

The Node workflow worker exports `FixedOperationCatalog` and `FixedOperationAdmission` for a non-serializable snapshot valid for one run on the issuing host. Pass `catalog().admission` in the fixed workflow options to bind execution to the checked registrations, reject withdrawn or replaced generations with `inactive-registration` before setup, and exclude operations registered later.

Fixed workflows can carry the booked run's credential port into the agent step, with the model target captured at admission.

The bundled `@makaio/core` exports the process launch types `ContainmentBoundary`, `OwnerLaunchOptions`, `OwnerQuiescence`, `ProcessLaunchOptions`, `ProcessOwner`, `SiteLaunchRefusal`, `SiteLaunchResult`, `SiteLaunchStatus`, and `SiteProcessOutcome`.

Follow-up selection and execution errors are reported through `afterStepsErrors`. The step result and facts remain available, and each selected follow-up is attempted once.

Successful preparation with confirmed process closure qualifies an active owner for independent cleanup even if a separate source registration is withdrawn before the preparation facts can be accepted.

The host requires confirmed closure of step processes and processes from earlier follow-ups before rechecking the checkout for a source-bound follow-up. The source provider and admitted resolver have source-bound follow-ups, and another contribution can opt in with `requiresVerifiedSource`. If a step detects a source mismatch, the mismatch remains the primary error and independent follow-ups still run. Independent follow-ups receive the run's source directory with no verified checkout or workflow root. The private directory may contain the checkout.

Retirement cancels operation children immediately. The coordinator continues when the extension's existing stop window expires. A callback still running keeps its private workspace and blocks reactivation of its extension until it settles. Operation phases follow the coordinator's dependency order across reactivation.

An already launched workflow step keeps the run's cancellation signal. If its registration is withdrawn, the worker discards the step result and starts no further step under that admission.
