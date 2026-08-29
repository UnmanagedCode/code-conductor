// The prototype of the System handle the registry is ACTUALLY handing out.
//
// There are two implementations of `System`: the in-process `LocalSystem` and
// the wire-protocol `ProviderSystem`, and `CC_LOCAL_SYSTEM_PROVIDER` decides
// which one `localSystem()` returns (src/systems/registry.ts). A spy installed
// on `LocalSystem.prototype` therefore observes NOTHING under the provider
// configuration — which is harmless for a positive assertion (it fails loudly)
// and dangerous for a NEGATIVE one ("this removal never happened"), which would
// pass for the wrong reason.
//
// So a test that wraps a System method wraps it here, on the live handle's own
// prototype, and stays true in whichever configuration it runs.
export function liveSystemProto(sys) {
  return Object.getPrototypeOf(sys);
}
