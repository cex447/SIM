function absoluteTrackUrl(track) {
  try {
    return new URL(track, window.location.href).toString();
  } catch {
    return track;
  }
}

async function readManifest(url) {
  if (!url) return [];

  try {
    const response = await fetch(
      `${url}${url.includes("?") ? "&" : "?"}_ts=${Date.now()}`,
      { cache: "no-store" }
    );

    if (!response.ok) return [];

    const json = await response.json();

    return Array.isArray(json.tracks)
      ? json.tracks
          .filter(track => typeof track === "string" && /\.mp3$/i.test(track))
          .map(absoluteTrackUrl)
      : [];
  } catch {
    return [];
  }
}

async function discoverGithubRoot(audioConfig) {
  const owner = audioConfig?.githubOwner;
  const repo = audioConfig?.githubRepo;
  const branch = audioConfig?.githubBranch || "main";

  if (!owner || !repo) return [];

  const endpoint =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/` +
    `${encodeURIComponent(repo)}/contents/?ref=${encodeURIComponent(branch)}`;

  try {
    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" }
    });

    if (!response.ok) return [];

    const items = await response.json();
    if (!Array.isArray(items)) return [];

    return items
      .filter(item =>
        item?.type === "file" &&
        /\.mp3$/i.test(item.name || "") &&
        item.download_url
      )
      .sort((a, b) =>
        String(a.name).localeCompare(String(b.name), "es", { numeric: true })
      )
      .map(item => item.download_url);
  } catch {
    return [];
  }
}

export class BackgroundAudio {
  constructor(audioConfig = {}) {
    this.config = audioConfig;
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.playsInline = true;

    this.tracks = [];
    this.index = 0;
    this.userEnabled = false;
    this.emaPaused = false;
    this.ready = false;
    this.tracksLoaded = false;
    this.loadingTracks = null;

    this.audio.addEventListener("ended", () => this.next());
    this.audio.addEventListener("error", () => this.next());
  }

  async init() {
    /*
     * Por defecto no suena ni se consultan los MP3.
     * El catálogo se carga únicamente cuando el usuario pulsa SIM+.
     */
    this.ready = this.config?.enabled !== false;
  }

  async ensureTracks() {
    if (!this.ready) return [];
    if (this.tracksLoaded) return this.tracks;
    if (this.loadingTracks) return this.loadingTracks;

    this.loadingTracks = (async () => {
      const manifestTracks =
        await readManifest(this.config?.manifestUrl);

      this.tracks = manifestTracks.length
        ? manifestTracks
        : await discoverGithubRoot(this.config);

      this.tracksLoaded = true;

      if (this.tracks.length) {
        this.setTrack(0);
      }

      return this.tracks;
    })();

    try {
      return await this.loadingTracks;
    } finally {
      this.loadingTracks = null;
    }
  }

  setTrack(index) {
    if (!this.tracks.length) return;

    this.index =
      ((index % this.tracks.length) + this.tracks.length) %
      this.tracks.length;

    const nextSrc = this.tracks[this.index];

    if (this.audio.src !== nextSrc) {
      this.audio.src = nextSrc;
      this.audio.load();
    }
  }

  async playIfAllowed() {
    if (
      !this.ready ||
      !this.userEnabled ||
      this.emaPaused
    ) {
      return false;
    }

    await this.ensureTracks();

    if (!this.tracks.length) {
      return false;
    }

    try {
      await this.audio.play();
      return true;
    } catch {
      return false;
    }
  }

  toggleByUser() {
    if (!this.userEnabled) {
      this.userEnabled = true;
      return this.playIfAllowed();
    }

    if (!this.audio.paused) {
      this.userEnabled = false;
      this.audio.pause();
      return false;
    }

    this.userEnabled = true;
    return this.playIfAllowed();
  }

  enterEMA() {
    this.emaPaused = true;
    this.audio.pause();
  }

  leaveEMA() {
    this.emaPaused = false;
    if (this.userEnabled) this.playIfAllowed();
  }

  next() {
    if (!this.tracks.length) return;
    this.setTrack(this.index + 1);
    if (this.userEnabled && !this.emaPaused) this.playIfAllowed();
  }

  state() {
    return {
      tracks: this.tracks.length,
      index: this.index,
      playing: !this.audio.paused,
      userEnabled: this.userEnabled,
      emaPaused: this.emaPaused
    };
  }
}
