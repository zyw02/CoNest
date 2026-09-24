# Security policy

CoNest currently serves trusted operators and components. Host tool policy and component grants constrain supported invocation paths; they do not sandbox arbitrary JavaScript installed by the OS account owner. Use separate OS/container boundaries for mutually untrusted operators or code. Shared graph memory is not tenant-isolated storage. See [host integration](docs/host-integration.md) for the implemented authorization contract.

## Report privately

Use GitHub's private **Report a vulnerability** entry on this repository if available. If it is unavailable, submit a minimal contact request asking the maintainer for a private route; omit exploit details, credentials and private data until that route is established. There is no separate published security mailbox, response-time commitment or bounty program.

A useful report includes the affected CoNest commit/version and platform, the relevant entry point, a minimal reproduction with synthetic data, the boundary crossed and demonstrated impact. Include dependency versions where relevant. Distinguish a confirmed exploit from a suspected weakness; incomplete reports are welcome when that uncertainty is explicit.

Do not publish an unpatched exploit in an issue, PR or attachment. Upstream dependency defects should also reach the upstream project's reporting channel; identify the CoNest path affected without attaching customer workloads.

## Maintainer handling

Reproduce in an isolated environment, assess the actual trust boundary and review affected maintained branches. Arrange a fix, regression coverage and coordinated disclosure before publishing technical exploit details. Record affected and fixed versions in the advisory or release. Do not claim every historical tag is supported; maintenance of `main` and `develop` does not establish a backport promise for earlier artifacts.
