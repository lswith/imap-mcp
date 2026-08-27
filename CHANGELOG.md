# Changelog

## [0.2.0](https://github.com/lswith/imap-mcp/compare/v0.1.0...v0.2.0) (2026-08-27)


### Features

* ask for the mailbox at deploy time, in one prompt list ([#57](https://github.com/lswith/imap-mcp/issues/57)) ([311e112](https://github.com/lswith/imap-mcp/commit/311e112e635e932499b43223d62384418b29973b))
* make a deployed instance observable — /status, log levels, vars ([#53](https://github.com/lswith/imap-mcp/issues/53)) ([b5e4a62](https://github.com/lswith/imap-mcp/commit/b5e4a62ed22838029905438f3c99ac87d80b36db))


### Bug Fixes

* pin cf-imap to the patched fork carrying the [#40](https://github.com/lswith/imap-mcp/issues/40) defect fixes ([#55](https://github.com/lswith/imap-mcp/issues/55)) ([9a508db](https://github.com/lswith/imap-mcp/commit/9a508dbae3297f4a4b23cc7121d751c15e5656e1))

## 0.1.0 (2026-08-27)


### Features

* **d1:** schema and migrations for the mailbox index ([#4](https://github.com/lswith/imap-mcp/issues/4)) ([e91a7ef](https://github.com/lswith/imap-mcp/commit/e91a7ef15f2373f9cc12cd1bc37a50ff77b49355))
* **d1:** schema and migrations for the mailbox index ([#4](https://github.com/lswith/imap-mcp/issues/4)) ([064826c](https://github.com/lswith/imap-mcp/commit/064826cfe444145a8c142fb6766054b19fab3b1b))
* deploy button, migrations in the deploy script ([#36](https://github.com/lswith/imap-mcp/issues/36)) ([#46](https://github.com/lswith/imap-mcp/issues/46)) ([79ac800](https://github.com/lswith/imap-mcp/commit/79ac800ad06ce552c2455ad9f4605c0719d8480f))
* **imap:** mailbox interface over cf-imap ([#3](https://github.com/lswith/imap-mcp/issues/3)) ([7fed8e8](https://github.com/lswith/imap-mcp/commit/7fed8e8e9b3a1dd5345d676e80af7108bb554a5e))
* **mcp:** gate the MCP endpoint with Access Managed OAuth ([ad8c84b](https://github.com/lswith/imap-mcp/commit/ad8c84bf4f33bafcb72f0654fb4fc90e7aa1ae06))
* **mcp:** gate the MCP endpoint with Access Managed OAuth ([#10](https://github.com/lswith/imap-mcp/issues/10)) ([8ad48b2](https://github.com/lswith/imap-mcp/commit/8ad48b2f87719f2ca0a8328df0415e732c4d64f7))
* **mcp:** stateless MCP server and search_messages ([#7](https://github.com/lswith/imap-mcp/issues/7)) ([dd24ded](https://github.com/lswith/imap-mcp/commit/dd24dedbb8392ae7546e6823cb002c307b935351))
* **mcp:** stateless MCP server and search_messages ([#7](https://github.com/lswith/imap-mcp/issues/7)) ([001d2dc](https://github.com/lswith/imap-mcp/commit/001d2dc9c3b08f494d07d520d0325fb9dfe27a42))
* releases from Conventional Commits, and a PR template ([#38](https://github.com/lswith/imap-mcp/issues/38)) ([#49](https://github.com/lswith/imap-mcp/issues/49)) ([f129333](https://github.com/lswith/imap-mcp/commit/f129333c0db8b3c367516961df4673e21334b90e))
* **scripts:** generate the deploy config; attach Access to the Worker ([ee34f80](https://github.com/lswith/imap-mcp/commit/ee34f803f44e1de91c3e84896487fa0d9bd2d488))
* **sync:** incremental enumeration, watermarks and UIDVALIDITY ([#8](https://github.com/lswith/imap-mcp/issues/8)) ([b47809a](https://github.com/lswith/imap-mcp/commit/b47809afa3b65359678b245ad6f8ac1601ae85b1))
* **sync:** incremental enumeration, watermarks and UIDVALIDITY ([#8](https://github.com/lswith/imap-mcp/issues/8)) ([2b4bee6](https://github.com/lswith/imap-mcp/commit/2b4bee6cbf482687c5217ac8465a3eb387798757))
* **sync:** queue fan-out for the sync path ([#6](https://github.com/lswith/imap-mcp/issues/6)) ([b114cc6](https://github.com/lswith/imap-mcp/commit/b114cc6d441ad905b8b2612a219fe6beffb4bcd5))
* **sync:** queue fan-out for the sync path ([#6](https://github.com/lswith/imap-mcp/issues/6)) ([fc6590c](https://github.com/lswith/imap-mcp/commit/fc6590cb5c6608c51fe61b7dfcc61955a4dffe53))
* **sync:** tracer sync of one folder into D1 ([#5](https://github.com/lswith/imap-mcp/issues/5)) ([733f630](https://github.com/lswith/imap-mcp/commit/733f630652dedd4621e8cca809837424deaf8303))
* **sync:** tracer sync of one folder into D1 ([#5](https://github.com/lswith/imap-mcp/issues/5)) ([25691af](https://github.com/lswith/imap-mcp/commit/25691af22b632f97d453e42cfb7aed34c59aec6a))
* two auth modes — mandatory API key, optional Cloudflare Access ([#35](https://github.com/lswith/imap-mcp/issues/35)) ([#45](https://github.com/lswith/imap-mcp/issues/45)) ([ee3d777](https://github.com/lswith/imap-mcp/commit/ee3d77747f418b5dd3afb1d312da634e90d42124))


### Bug Fixes

* **deps:** declare typescript@6.0.3 in the lockfile ([5a2126f](https://github.com/lswith/imap-mcp/commit/5a2126fc6e43b0ddba2b8ff74d0534f02e07ff46))
* exempt the release-please manifest from Biome formatting ([#51](https://github.com/lswith/imap-mcp/issues/51)) ([f92caba](https://github.com/lswith/imap-mcp/commit/f92cabaf3efa7712f12bd96d120cf1481bb0b576))
* **scripts:** correct the deploy ordering the setup wizard prints ([c1caf77](https://github.com/lswith/imap-mcp/commit/c1caf77c9ffa3b28bb7b0898b33bff2415501fdd))
