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
      headers: {
        Accept: "application/vnd.github+json"
      }
    });

    if (!response.ok) return [];

    const items = await response.json();

    if (!Array.isArray(items)) return [];

    return items
      .filter(
        item =>
          item?.type === "file" &&
          /\.mp3$/i.test(item.name || "") &&
          item.download_url
      )
      .sort((a, b) =>
        String(a.name).localeCompare(String(b.name), "es", {
          numeric: true
        })
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
    this.userPaused = false;
    this.emaPaused = false;
    this.wantsPlayback = true;
    this.ready = false;

    this.audio.addEventListener("ended", () => {
      this.next();
    });

    this.audio.addEventListener("error", () => {
      this.next();
    });
  }

  async init() {
    if (this.config?.enabled === false) return;

    const manifestTracks = await readManifest(
      this.config?.manifestUrl
    );

    this.tracks = manifestTracks.length
      ? manifestTracks
      : await discoverGithubRoot(this.config);

    this.ready = true;

    if (this.tracks.length) {
      this.setTrack(0);
      this.tryPlay();
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

  async tryPlay() {
    if (
      !this.ready ||
      !this.tracks.length ||
      this.userPaused ||
      this.emaPaused ||
      !this.wantsPlayback
    ) {
      return false;
    }

    try {
      await this.audio.play();
      return true;
    } catch {
      // iOS/Safari puede exigir una interacción del usuario.
      return false;
    }
  }

  async unlockFromUserGesture() {
    return this.tryPlay();
  }

  pauseByUser() {
    this.userPaused = true;
    this.audio.pause();
  }

  resumeByUser() {
    this.userPaused = false;
    this.wantsPlayback = true;
    return this.tryPlay();
  }

  toggleByUser() {
    if (!this.audio.paused && !this.userPaused) {
      this.pauseByUser();
      return;
    }

    this.resumeByUser();
  }

  enterEMA() {
    this.emaPaused = true;
    this.audio.pause();
  }

  leaveEMA() {
    this.emaPaused = false;

    if (!this.userPaused) {
      this.tryPlay();
    }
  }

  next() {
    if (!this.tracks.length) return;

    this.setTrack(this.index + 1);

    if (!this.userPaused && !this.emaPaused) {
      this.tryPlay();
    }
  }

  state() {
    return {
      tracks: this.tracks.length,
      index: this.index,
      playing: !this.audio.paused,
      userPaused: this.userPaused,
      emaPaused: this.emaPaused
    };
  }
}
