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
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "es", { numeric: true }))
      .map(item => item.download_url);
  } catch {
    return [];
  }
}

export class BackgroundAudio {
  constructor(audioConfig = {}) {
    this.config = audioConfig;
    this.audio = new Audio();
    this.audio.preload = "metadata";
    this.audio.playsInline = true;

    this.tracks = [];
    this.index = 0;
    this.enabledByUser = false;
    this.sivPaused = false;
    this.loaded = false;
    this.loadingPromise = null;

    this.audio.addEventListener("ended", () => this.next());
    this.audio.addEventListener("error", () => this.next());
  }

  init() {
    // Preparamos silenciosamente la lista de pistas para que el primer toque
    // sobre SIM+ pueda llamar a audio.play() dentro del gesto de usuario de iOS.
    // No se reproduce sonido hasta que el usuario pulsa SIM+.
    if (this.config?.enabled !== false) this.ensureTracks();
  }

  async ensureTracks() {
    if (this.loaded) return;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      const manifestTracks = await readManifest(this.config?.manifestUrl);
      this.tracks = manifestTracks.length
        ? manifestTracks
        : await discoverGithubRoot(this.config);

      this.loaded = true;
      this.loadingPromise = null;

      if (this.tracks.length) this.setTrack(0);
    })();

    return this.loadingPromise;
  }

  setTrack(index) {
    if (!this.tracks.length) return;

    this.index = ((index % this.tracks.length) + this.tracks.length) % this.tracks.length;
    const nextSrc = this.tracks[this.index];

    if (this.audio.src !== nextSrc) {
      this.audio.src = nextSrc;
      this.audio.load();
    }
  }

  play() {
    if (
      this.config?.enabled === false ||
      !this.enabledByUser ||
      this.sivPaused
    ) {
      return Promise.resolve(false);
    }

    if (!this.loaded) {
      return this.ensureTracks().then(() => this.play());
    }

    if (!this.tracks.length) return Promise.resolve(false);

    try {
      const result = this.audio.play();
      return Promise.resolve(result).then(() => true).catch(() => false);
    } catch {
      return Promise.resolve(false);
    }
  }

  async toggleByUser() {
    if (this.enabledByUser) {
      this.enabledByUser = false;
      this.audio.pause();
      return false;
    }

    this.enabledByUser = true;
    return this.play();
  }

  enterSIV() {
    this.sivPaused = true;
    this.audio.pause();
  }

  leaveSIV() {
    this.sivPaused = false;
    if (this.enabledByUser) this.play();
  }

  next() {
    if (!this.tracks.length) return;
    this.setTrack(this.index + 1);
    if (this.enabledByUser && !this.sivPaused) this.play();
  }

  state() {
    return {
      tracks: this.tracks.length,
      index: this.index,
      playing: !this.audio.paused,
      enabledByUser: this.enabledByUser,
      sivPaused: this.sivPaused,
      loaded: this.loaded
    };
  }
}
