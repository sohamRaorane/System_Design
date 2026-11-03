# Diagrams

| File | What it is |
|---|---|
| `architecture-v1.png` | The original Phase 1 design diagram (reference; kept unchanged) |
| `architecture-v2.mmd` / `.svg` | The system as built (Mermaid source and rendered SVG) |

Regenerate the SVG after editing the source:

```bash
npx -y @mermaid-js/mermaid-cli -i docs/diagram/architecture-v2.mmd -o docs/diagram/architecture-v2.svg -b white
```

## Errata for architecture-v1.png

| Where | Says | Should say |
|---|---|---|
| Section numbers | "6" appears twice (Control Plane and Storage Layer) | Control Plane is 6, Storage Layer is 6b (or renumber Storage 7 and Failure Scenarios 8) |
| Bottom-left panel title | "Dseone 1 HERKR" | Hot storage |
| Storage Layer, middle box | "Rletiy Worker", "Battiriy old traces", "Upload to failure" | Archive worker, "Batching old traces", "Upload to cold storage" |
| Hot storage box | "Compress 6 / s / batch" | Compressed in batches |
| Archive Worker box | "Rpload tn false storage" | Upload to cold storage |
| Collector Cluster | "Stateless, horizontally scalable" | The aggregator keeps per-trace state in memory, so one instance is run; scaling out needs trace-id routing (architecture gap G7) |
