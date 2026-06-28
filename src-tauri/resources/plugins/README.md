Place bundled CLIProxyApi plugins in this directory.

The app copies these files into the runtime plugins directory before starting
CLIProxyApi. The `cloud-quota-card` plugin remains disabled by default because
Go c-shared plugins can crash when loaded into the Go CLIProxyApi host process
on macOS.

Cloud quota card plugin source is in `../plugins-src/cloud-quota-card`.

Build for the current machine:

```bash
bash src-tauri/resources/plugins-src/cloud-quota-card/build.sh
```

The output is placed under a platform directory, for example:

```text
src-tauri/resources/plugins/darwin/amd64/cloud-quota-card.dylib
```

This keeps the downloaded quota card as encrypted JSON on disk. At request time
the plugin checks Cloud quota, decrypts only in memory, applies the credential
headers, sends the request through the host HTTP channel, and reports usage.
