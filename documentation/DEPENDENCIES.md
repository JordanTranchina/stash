# Project Dependency Graph

This graph visualizes the blocking relationships between the GitHub issues. **Arrow direction**: Predecessor (Blocker) $\rightarrow$ Successor (Blocked).

```mermaid
graph TD
    %% Subgraph: Listen Later (Podcast)
    subgraph Podcast [Listen Later (AI Podcast)]
        direction TB
        I6[#6 Data Extraction] --> I7[#7 Scriptwriting]
        I7 --> I8[#8 Audio Generation]
        I8 --> I9[#9 Audio Assembly]
        I9 --> I10[#10 RSS Generation]
    end

    %% Subgraph: Dependencies/Enhancements
    subgraph Enhancements [Enhancements]
        I7 --> I13[#13 Host Personalities]
        I9 --> I14[#14 Interactive Chapters]
        I10 --> I11[#11 Morning Brief]
        I10 --> I12[#12 On-Demand Podcast]
    end

    %% Subgraph: PWA
    subgraph PWA [PWA / Offline]
        I4[#4 Pending Queue Sync] --> I5[#5 Background Sync]
    end

    %% Styling
    classDef default fill:#ffffff,stroke:#333,stroke-width:1px;
    classDef core fill:#e1f5fe,stroke:#01579b,stroke-width:2px;
    classDef block fill:#ffebee,stroke:#b71c1c,stroke-width:2px;

    class I6,I7,I8,I9,I10,I4 core;
    class I13,I14,I11,I12,I5 default;

    %% Click events (optional, for supported renderers)
    click I6 "https://github.com/JordanTranchina/stash/issues/6"
    click I7 "https://github.com/JordanTranchina/stash/issues/7"
    click I8 "https://github.com/JordanTranchina/stash/issues/8"
    click I9 "https://github.com/JordanTranchina/stash/issues/9"
    click I10 "https://github.com/JordanTranchina/stash/issues/10"
    click I4 "https://github.com/JordanTranchina/stash/issues/4"
```

## Legend

- **Blue Nodes**: Core Pipeline / Critical Path
- **White Nodes**: Enhancements / Secondary Features
