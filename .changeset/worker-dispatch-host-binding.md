---
"@makaio/contracts": minor
"@makaio/framework": minor
"@makaio/runtime-node": minor
"@makaio/runtime-bun": minor
---

Expose ordered worker start, supervision, and allocation binding through `workerDispatch` on configured Node and Bun extension contexts. The host owns process-bound allocations, drains provisioning on shutdown, and records confirmed teardown. Shutdown settles a claimed start that aborts before its provider request is sent. While storage remains open, the host records confirmed teardown when a process-bound handle arrives after the drain, including for a verified handle with no stored allocation binding. For a settled dispatch, the sender records a valid late managed reference even after the provisioning drain closes while storage remains available. When the host confirms that a late managed allocation's reference has been durably recorded, it attempts teardown only by reference. The host attempts to release the local handle even if teardown is unconfirmed or the locked read fails. After the provisioning drain, if storage is closed or the reference write is rejected, the host falls back to a best-effort termination attempt through the handle. The host records confirmed teardown against the matching reference when storage permits. A pending reference remains available for recovery. Supervision returns bounded attach diagnostics. Foreign discoveries leave the cleanup obligation open.

Extensions supply providers through the new `MakaioExtension.workerProviders` field. Boot silently ignores this contribution when `workerDispatch` is unconfigured. The host registers each activation's batch under the contributing extension's identity. Stopping the extension withdraws its providers from selection and preserves access for outstanding cleanup. A provider ID identifies one durable backend. Later activations using the same ID must be able to observe and clean up allocations created by earlier activations. A different backend requires a new ID. The `workerDispatch` boot option takes `source`, `scopeSetting`, and `connection`. This replaces the provider registry option introduced in an earlier revision of this feature. The boot option and contribution field are additive relative to the previous release surface.

The new `ExtensionWorkerProvidersContribution` and `WorkerProviderContribution` types are available from `@makaio/contracts` and `@makaio/contracts/extension`. Both entries also expose `DispatchBinding`, `OrderedProvisionOutcome`, `OrderedProvisionRequest`, `OrderedWorkerProvider`, `OrderedWorkerRecovery`, `SealedAllocationSet`, and `UniqueLiveAllocation` for implementing providers.

Providers must tolerate repeated `terminate()` calls after an unconfirmed termination attempt. After the extension stops, `provision` must honor its abort signal and `WorkerHandle.terminate` must remain usable.

`@makaio/contracts/capabilities` and `@makaio/framework/contracts/capabilities` expose `PreparedAllocationBinding`, `StartOrder`, `StartOrderedWorker`, `StartValueVisibility`, `StartWorkerResult`, `WorkerAttachFailure`, and `WorkerDispatchCapability`.

The `@makaio/framework/services/worker-provider` subpath exports the types `AllocationScopeSetting`, `CommittedWorkerOrder`, `DispatchBinding`, `OrderedProvisionOutcome`, `OrderedProvisionRequest`, `OrderedWorkerProvider`, `OrderedWorkerRecovery`, `PreparedAllocationBinding`, `SealedAllocationSet`, `StartOrder`, `StartOrderedWorker`, `StartValueVisibility`, `StartWorkerResult`, `UniqueLiveAllocation`, `WorkerAttachFailure`, `WorkerDispatchCapability`, and `WorkerOrderSource`.

The Node runtime composes the host dispatch port using the framework’s internal service entry, which carries no compatibility promise. The runtime package uses its existing build and import rewriting.

Hosts can construct `workerDispatch.scopeSetting` from operator configuration with `readAllocationScopeSetting` from `@makaio/framework/services/internal/worker-provider-host-binding`, an internal entry with no compatibility promise.
