# Client crash diagnostics

This workflow correlates three independent clocks:

1. the server's throwable lifecycle and outbound packet trace;
2. the SOE client crash payload;
3. an optional packet capture decoded with `H1emu/soe-network-parser`.

## Capture a crash report

The 2016 client configuration contains a `[CrashReporter]` section. Start the
receiver and optionally configure a specific client file:

```powershell
.\scripts\Start-H1CrashCapture.ps1 `
  -ConfigureClient `
  -ClientConfigPath "C:\path\to\CustomClientConfig.ini"
```

The script makes a one-time `.h1emu-crashcapture.bak` copy before changing the
address. Reports are written beneath `%APPDATA%\h1emu\crashes` as `.bin`,
printable `.txt`, and `.json` metadata files. The receiver binds only to
`127.0.0.1:4750` by default.

## Correlate the server trace

Throwable launches automatically write JSON Lines to:

```text
%APPDATA%\h1emu\logs\throwable-trace.jsonl
```

Each launch records its item, owner, projectile identifiers, position, trigger,
destroy, and all outbound packet names/opcodes during the five-second trace
window. Set `H1EMU_THROWABLE_TRACE=0` to disable it or
`H1EMU_THROWABLE_TRACE_PATH` to choose another file.

After reproducing a grenade crash, compare the last JSONL timestamp with the
captured crash metadata. Preserve both artifacts before testing another build.

## Optional packet capture

Capture the local SOE traffic with Wireshark, save it as pcap/pcapng, then use
`H1emu/soe-network-parser` to identify the last decoded transport frames. The
server JSONL provides semantic packet names; the parser establishes ordering,
ACKs, retransmits, and the last client/server frame before the exception.
