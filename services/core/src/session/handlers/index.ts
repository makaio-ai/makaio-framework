export { registerAbandonHandler } from './abandon-handler.js';
export { registerAttachHandler } from './attach-handler.js';
export { registerCompressHandler } from './compress-handler.js';
export { registerForkHandler } from './fork-handler.js';
export { registerMergeHandler } from './merge-handler.js';
// The in-flight-start consumer rule (§4.5). Exported because *every* send path
// owes it, not only the framework orchestrator's: a send that probes liveness
// without arbitrating the starts already in flight walks into a second lifecycle
// for an identity that has one, and a reserved recovery deliberately refuses a
// `starting` row rather than arbitrating it. A product send composes its own
// pipeline and needs the same step; the alternative is a second implementation
// of a rule whose whole value is that there is one.
export {
  resolveInFlightStarts,
  type InFlightStartResolution,
  type StartResolution,
} from './in-flight-start-join.js';
// The fresh-start admission and the refusal a total deferral raises. Exported
// for the same reason as the rule above: *whether* a product's send refuses is
// its own decision, but the failure it raises is one fact with one code and one
// wording, and a product that rebuilds it answers "what did this send fail with"
// a second way. The admission is more than a shared wording — it is the contract
// that only the default send may bootstrap a session, and a send pipeline that
// omits it starts a lead for a send that was already decided.
export { admitFreshStartTargets, refuseTotalDeferral } from './deferred-agents.js';
export { routeToAgents } from './route-to-agents.js';
export { routeToAgentsCore } from './route-to-agents-core.js';
