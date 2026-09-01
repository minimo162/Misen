# Prepared runtime (Phase A)

The prepared runtime is built on a development or packaging host. The target
machine never installs dependencies, builds TypeScript, downloads a runtime, or
uses a PowerShell fallback.

```powershell
npm run prepare-runtime -- --output C:\staging\misen-enterprise `
  --source-sha 06804c5eb0c8f9e42322d66b11c2f5ae0153da69 `
  --packaging-sha <40-character-packaging-commit>
```

The output directory must be absent or empty. Packaging fails closed and removes
the incomplete directory on error. The package contains `run.cmd`, a synthetic
workspace, the compiled runtime, production dependencies, a manifest, the exact
dependency lock used for staging, and `SHA256SUMS.txt`.

The source SHA is fixed to the merged Pi baseline. The packaging SHA must equal
the current clean Git `HEAD`, and the protected production tree must still match
that baseline. The manifest declares required paths, the installed production
package count, and an inventory whose explicit scope is every distributed file
except the self-referential hash list.

The generator normalizes only ZIP container timestamps in the generated
synthetic `.xlsx` fixtures. Workbook content is unchanged; this makes two
packages from the same source and packaging SHAs byte-for-byte reproducible.

On the target machine, place the approved Node.js 22 runtime on `PATH` and run:

```cmd
run.cmd
```

An absolute workspace may be supplied as the first argument. The launcher does
not elevate privileges or fall back to another executable. Corporate policy and
application-control approval remain external prerequisites.

Before transfer, verify exact file-set hashes and inventory, a Node-only `PATH`,
the recursive target process tree, `/state`, stable-startup TCP observations,
and cleanup:

```powershell
npm run verify:prepared-runtime -- --runtime C:\staging\misen-enterprise
```

The network evidence is deliberately narrow: ten stable-startup TCP samples
over one second must show only loopback/wildcard endpoints. It is not claimed as
packet capture or proof that an arbitrarily short transient connection could
never occur.
