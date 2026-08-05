"use client";

import { upload as uploadToBlob } from "@vercel/blob/client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";

type Touch = {
  id: number;
  rally_id: number;
  start_time: number;
  end_time: number;
  action: string;
  player: string;
  outcome: string;
  notes: string;
  confidence: number;
};

type Rally = {
  id: number;
  match_id: number;
  start_time: number;
  end_time: number;
  phase: string;
  result: string;
  confidence: number;
  touches: Touch[];
};


type CourtPoint = {
  x: number;
  y: number;
};

type CourtCalibration = {
  points: CourtPoint[];
  confirmed: boolean;
  frame_time: number;
};

type Match = {
  id: number;
  title: string;
  opponent: string;
  status: string;
  duration_seconds: number;
  created_at: string;
  rallies: Rally[];
  video_url: string;
  local_preview_url?: string;
  upload_progress?: number;
  filename: string;
  file_size?: number;
  storage_provider: "vercel-blob";
  court_calibration?: CourtCalibration;
};

type RosterPlayer = {
  number: string;
  name: string;
  build: string;
  role: string;
};

type PlaybackMode = "normal" | "rally-only" | "top5";

const MATCH_LIBRARY_KEY = "volleyvision-cloud-matches-v1";
const ROSTER_KEY = "volleyvision-roster-v3";
const MAX_METADATA_MATCHES = 50;
const MAX_CLIENT_UPLOAD_BYTES = 25 * 1024 * 1024 * 1024; // App guard. Your Vercel plan/storage limits may be lower.

function bytesToSize(bytes = 0) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function readMatchLibrary(): Match[] {
  try {
    return JSON.parse(window.localStorage.getItem(MATCH_LIBRARY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveMatchLibrary(matches: Match[]) {
  const persistable = matches.slice(0, MAX_METADATA_MATCHES).map(({ local_preview_url, ...match }) => ({
    ...match,
    upload_progress: match.status.includes("upload") ? 0 : match.upload_progress,
  }));
  window.localStorage.setItem(MATCH_LIBRARY_KEY, JSON.stringify(persistable));
}

function playerText(p?: RosterPlayer) {
  if (!p) return "Unknown";
  return `#${p.number || "?"} ${p.name || "Player"}`;
}

function rolePick(roster: RosterPlayer[], role: string, fallbackIndex: number) {
  if (!roster.length) return undefined;
  const needle = role.toLowerCase();
  const hit = roster.find(
    (p) =>
      p.role.toLowerCase().includes(needle) ||
      p.build.toLowerCase().includes(needle),
  );
  return hit || roster[fallbackIndex % roster.length];
}

function makeRallies(duration: number, matchId: number, roster: RosterPlayer[]) {
  const rallies: Rally[] = [];
  const phases = [
    "Serve receive",
    "Free ball transition",
    "Out-of-system receive",
    "Defensive transition",
    "Sideout receive",
  ];
  const results = ["kill", "kept alive", "error", "tip covered", "block touch", "point won"];

  let t = 4;
  let i = 0;
  while (t < duration - 5) {
    const rallyLength = Math.min(9 + (i % 5) * 2.5, Math.max(5, duration - t));
    const receive = rolePick(roster, "pass", i) || rolePick(roster, "defensive", i) || roster[i % Math.max(1, roster.length)];
    const setter = rolePick(roster, "setter", i + 1) || roster[(i + 1) % Math.max(1, roster.length)];
    const attacker = rolePick(roster, "hitter", i + 2) || rolePick(roster, "outside", i + 2) || roster[(i + 2) % Math.max(1, roster.length)];
    const cover = rolePick(roster, "middle", i + 3) || roster[(i + 3) % Math.max(1, roster.length)];
    const base = Math.round(t * 10) / 10;

    const touchSpecs = [
      {
        off: 0,
        len: 1.4,
        action: i % 4 === 0 ? "Serve" : "Serve receive / pass",
        player: i % 4 === 0 ? attacker : receive,
        outcome: i % 4 === 0 ? "serve in" : "in-system pass",
      },
      {
        off: Math.min(2.4, rallyLength * 0.25),
        len: 1.2,
        action: "Set",
        player: setter,
        outcome: "set to pin/middle",
      },
      {
        off: Math.min(4.6, rallyLength * 0.48),
        len: 1.5,
        action: "Attack",
        player: attacker,
        outcome: results[i % results.length],
      },
      {
        off: Math.min(6.8, rallyLength * 0.68),
        len: 1.4,
        action: i % 3 === 0 ? "Block touch" : "Dig / cover",
        player: cover,
        outcome: i % 3 === 0 ? "block touch" : "kept alive",
      },
    ];

    const touches = touchSpecs
      .filter((spec) => spec.off < rallyLength - 0.5)
      .map((spec, j) => ({
        id: matchId + i * 100 + j,
        rally_id: matchId + i,
        start_time: Math.round((base + spec.off) * 10) / 10,
        end_time: Math.round(Math.min(base + rallyLength, base + spec.off + spec.len) * 10) / 10,
        action: spec.action,
        player: playerText(spec.player),
        outcome: spec.outcome,
        notes: "Estimated from timing + roster role hints. Future upgrade: YOLO players, jersey OCR, pose tracking, and ball tracking.",
        confidence: 0.48 + ((i + j) % 5) * 0.07,
      }));

    rallies.push({
      id: matchId + i,
      match_id: matchId,
      start_time: base,
      end_time: Math.round((base + rallyLength) * 10) / 10,
      phase: phases[i % phases.length],
      result: results[i % results.length],
      confidence: 0.5 + (i % 4) * 0.08,
      touches,
    });

    t += rallyLength + 5 + (i % 4) * 3;
    i += 1;
  }

  return rallies;
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeRowRef = useRef<HTMLTableRowElement | null>(null);
  const uploadStartedAtRef = useRef<number>(0);
  const localPreviewUrlsRef = useRef<string[]>([]);
  const draggingCornerRef = useRef<number | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [libraryReady, setLibraryReady] = useState(false);
  const [storageMessage, setStorageMessage] = useState("Videos upload to Vercel Blob and stay out of Git.");
  const [selected, setSelected] = useState<Match | null>(null);
  const [title, setTitle] = useState("Varsity Match");
  const [opponent, setOpponent] = useState("Opponent");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState("Idle");
  const [uploadSpeed, setUploadSpeed] = useState("");
  const [analyzeStatus, setAnalyzeStatus] = useState("AI worker not run yet");
  const [analyzing, setAnalyzing] = useState(false);
  const [courtPoints, setCourtPoints] = useState<CourtPoint[]>([]);
  const [courtCalibrationMode, setCourtCalibrationMode] = useState(false);
  const [courtConfirmed, setCourtConfirmed] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [currentTouchId, setCurrentTouchId] = useState<number | null>(null);
  const [currentRallyId, setCurrentRallyId] = useState<number | null>(null);
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>("normal");
  const [activePlaylist, setActivePlaylist] = useState<Rally[]>([]);
  const [playlistIndex, setPlaylistIndex] = useState(0);
  const [tagPlayer, setTagPlayer] = useState("#12");
  const [tagAction, setTagAction] = useState("attack");
  const [tagOutcome, setTagOutcome] = useState("kill");
  const [roster, setRoster] = useState<RosterPlayer[]>([
    { number: "8", name: "Player 8", build: "tall outside/right-side build", role: "outside hitter" },
    { number: "12", name: "Player 12", build: "middle/tall blocker build", role: "middle blocker" },
    { number: "1", name: "Player 1", build: "setter/defensive build", role: "setter" },
    { number: "2", name: "Player 2", build: "left-back passer build", role: "passer/libero" },
    { number: "3", name: "Player 3", build: "right-back defender build", role: "defensive specialist" },
    { number: "4", name: "Player 4", build: "outside hitter build", role: "hitter" },
  ]);

  useEffect(() => {
    const savedRoster = window.localStorage.getItem(ROSTER_KEY);
    if (savedRoster) setRoster(JSON.parse(savedRoster));
    const restored = readMatchLibrary();
    setMatches(restored);
    setSelected(restored[0] || null);
    setLibraryReady(true);
    const total = restored.reduce((sum, m) => sum + (m.file_size || 0), 0);
    setStorageMessage(
      restored.length
        ? `${restored.length} cloud videos · ${bytesToSize(total)} referenced from Vercel Blob`
        : "No saved cloud videos yet. Uploads will be stored in Vercel Blob, not browser storage or Git.",
    );
  }, []);

  useEffect(() => {
    window.localStorage.setItem(ROSTER_KEY, JSON.stringify(roster));
  }, [roster]);

  useEffect(() => {
    if (!libraryReady) return;
    saveMatchLibrary(matches);
    const total = matches.reduce((sum, m) => sum + (m.file_size || 0), 0);
    setStorageMessage(`${matches.length} cloud videos · ${bytesToSize(total)} referenced from Vercel Blob`);
  }, [matches, libraryReady]);

  useEffect(() => {
    return () => {
      localPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      localPreviewUrlsRef.current = [];
    };
  }, []);

  useEffect(() => {
    setCourtPoints(selected?.court_calibration?.points || []);
    setCourtConfirmed(Boolean(selected?.court_calibration?.confirmed));
    setCourtCalibrationMode(false);
    draggingCornerRef.current = null;
  }, [selected?.id]);

  const sortedRallies = useMemo(() => [...(selected?.rallies || [])].sort((a, b) => a.start_time - b.start_time), [selected]);
  const allTouches = useMemo(
    () => sortedRallies.flatMap((r) => r.touches.map((t) => ({ ...t, rally: r }))).sort((a, b) => a.start_time - b.start_time),
    [sortedRallies],
  );
  const top5Rallies = useMemo(() => [...sortedRallies].sort((a, b) => b.confidence - a.confidence).slice(0, 5), [sortedRallies]);
  const activeTouch = useMemo(
    () => allTouches.find((t) => currentTime >= t.start_time && currentTime < t.end_time) || allTouches.filter((t) => t.start_time <= currentTime).at(-1) || null,
    [allTouches, currentTime],
  );
  const activeRally = useMemo(
    () => sortedRallies.find((r) => currentTime >= r.start_time && currentTime < r.end_time) || sortedRallies.filter((r) => r.start_time <= currentTime).at(-1) || null,
    [sortedRallies, currentTime],
  );

  useEffect(() => {
    setCurrentTouchId(activeTouch?.id || null);
    setCurrentRallyId(activeRally?.id || null);
  }, [activeTouch, activeRally]);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentTouchId]);

  function jumpToTime(seconds: number, autoplay = true) {
    setPlaybackMode("normal");
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(0, seconds);
      setCurrentTime(seconds);
      if (autoplay) videoRef.current.play();
    }
  }

  function beginCourtCalibration() {
    if (!selected || !videoRef.current) return;
    videoRef.current.pause();
    setPlaybackMode("normal");
    setCourtCalibrationMode(true);
    setCourtConfirmed(false);
    setCourtPoints([]);
    draggingCornerRef.current = null;
  }

  function resetCourtCalibration() {
    setCourtPoints([]);
    setCourtConfirmed(false);
    setCourtCalibrationMode(true);
    draggingCornerRef.current = null;
  }

  function normalizedPointFromPointer(
    event: MouseEvent<HTMLDivElement> | PointerEvent<SVGCircleElement>,
    element: HTMLElement | SVGElement,
  ): CourtPoint {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
    };
  }

  function addCourtCorner(event: MouseEvent<HTMLDivElement>) {
    if (!courtCalibrationMode || courtPoints.length >= 4) return;
    const point = normalizedPointFromPointer(event, event.currentTarget);
    setCourtPoints((points) => [...points, point]);
  }

  function startCornerDrag(index: number, event: PointerEvent<SVGCircleElement>) {
    if (!courtCalibrationMode) return;
    event.preventDefault();
    event.stopPropagation();
    draggingCornerRef.current = index;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function dragCorner(index: number, event: PointerEvent<SVGCircleElement>) {
    if (!courtCalibrationMode || draggingCornerRef.current !== index) return;
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const point = normalizedPointFromPointer(event, svg);
    setCourtPoints((points) => points.map((existing, pointIndex) => (pointIndex === index ? point : existing)));
  }

  function stopCornerDrag(event: PointerEvent<SVGCircleElement>) {
    draggingCornerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function confirmCourtCalibration() {
    if (!selected || courtPoints.length !== 4) {
      return alert("Select all four court corners before confirming.");
    }

    const calibration: CourtCalibration = {
      points: courtPoints,
      confirmed: true,
      frame_time: videoRef.current?.currentTime || currentTime,
    };
    const updated = { ...selected, court_calibration: calibration };

    setSelected(updated);
    setMatches((previous) => previous.map((match) => (match.id === selected.id ? updated : match)));
    setCourtConfirmed(true);
    setCourtCalibrationMode(false);
    draggingCornerRef.current = null;
  }

  async function upload() {
    if (!file) {
      alert("Choose a video first.");
      return;
    }

    if (file.size > MAX_CLIENT_UPLOAD_BYTES) {
      alert(
        `This file is ${bytesToSize(file.size)}. The current limit is ${bytesToSize(
          MAX_CLIENT_UPLOAD_BYTES,
        )}.`,
      );
      return;
    }

    setLoading(true);
    setUploadProgress(0);
    setUploadSpeed("");
    setUploadStatus("Preparing local video preview...");
    setPlaybackMode("normal");

    const matchId = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const pathname = `matches/${matchId}-${safeName}`;
    let localPreviewUrl = "";

    try {
      localPreviewUrl = URL.createObjectURL(file);
      localPreviewUrlsRef.current.push(localPreviewUrl);

      const probe = document.createElement("video");
      probe.preload = "metadata";
      probe.muted = true;
      probe.src = localPreviewUrl;

      const duration = await new Promise<number>((resolve) => {
        let finished = false;

        const complete = (value: number) => {
          if (finished) return;
          finished = true;
          resolve(value);
        };

        probe.onloadedmetadata = () => {
          complete(Number.isFinite(probe.duration) ? probe.duration : 0);
        };
        probe.onerror = () => complete(0);
        window.setTimeout(() => complete(0), 3000);
      });

      const safeDuration =
        duration > 0
          ? duration
          : file.size > 4 * 1024 * 1024 * 1024
            ? 90 * 60
            : 60 * 60;

      const localMatch: Match = {
        id: matchId,
        title,
        opponent,
        status: "local preview ready",
        duration_seconds: safeDuration,
        created_at: new Date().toISOString(),
        rallies: makeRallies(safeDuration, matchId, roster),
        video_url: localPreviewUrl,
        local_preview_url: localPreviewUrl,
        upload_progress: 0,
        filename: file.name,
        file_size: file.size,
        storage_provider: "vercel-blob",
      };

      setMatches((previous) =>
        [localMatch, ...previous].slice(0, MAX_METADATA_MATCHES),
      );
      setSelected(localMatch);
      setCourtPoints([]);
      setCourtConfirmed(false);
      setCourtCalibrationMode(false);

      setUploadStatus("Local preview ready. Starting cloud upload...");
      uploadStartedAtRef.current = Date.now();

      try {
        const blob = await uploadToBlob(pathname, file, {
          access: "public",
          handleUploadUrl: "/api/blob-upload",
          onUploadProgress: (event) => {
            const loaded = event.loaded || 0;
            const total = event.total || file.size || 1;
            const percentage =
              typeof event.percentage === "number"
                ? event.percentage
                : Math.round((loaded / Math.max(1, total)) * 100);
            const safePercentage = Math.max(
              1,
              Math.min(99, Math.round(percentage)),
            );
            const elapsedSeconds = Math.max(
              1,
              (Date.now() - uploadStartedAtRef.current) / 1000,
            );
            const megabytesPerSecond =
              loaded / 1024 / 1024 / elapsedSeconds;

            setUploadProgress(safePercentage);
            setUploadSpeed(
              `${megabytesPerSecond.toFixed(1)} MB/s · ${bytesToSize(
                loaded,
              )} / ${bytesToSize(total)}`,
            );
            setUploadStatus("Uploading full match to Vercel Blob...");

            setMatches((previous) =>
              previous.map((match) =>
                match.id === matchId
                  ? {
                      ...match,
                      status: `uploading ${safePercentage}%`,
                      upload_progress: safePercentage,
                    }
                  : match,
              ),
            );
          },
        });

        const cloudMatch: Match = {
          ...localMatch,
          status: "saved to Vercel Blob",
          video_url: blob.url,
          local_preview_url: localPreviewUrl,
          upload_progress: 100,
        };

        setUploadProgress(100);
        setUploadStatus("Upload complete. Cloud video is ready.");
        setSelected((current) =>
          current?.id === matchId ? cloudMatch : current,
        );
        setMatches((previous) =>
          previous.map((match) =>
            match.id === matchId ? cloudMatch : match,
          ),
        );
      } catch (cloudError) {
        console.error("Cloud upload failed:", cloudError);

        const localOnlyMatch: Match = {
          ...localMatch,
          status: "local preview only — cloud upload failed",
          upload_progress: 0,
        };

        setSelected((current) =>
          current?.id === matchId ? localOnlyMatch : current,
        );
        setMatches((previous) =>
          previous.map((match) =>
            match.id === matchId ? localOnlyMatch : match,
          ),
        );
        setUploadProgress(0);
        setUploadSpeed("");
        setUploadStatus(
          "Cloud upload failed, but the local preview is ready.",
        );
      }
    } catch (error) {
      console.error("Could not prepare video:", error);

      if (localPreviewUrl) {
        URL.revokeObjectURL(localPreviewUrl);
        localPreviewUrlsRef.current = localPreviewUrlsRef.current.filter(
          (url) => url !== localPreviewUrl,
        );
      }

      setUploadStatus("Could not open the selected video.");
      setUploadProgress(0);
      setUploadSpeed("");
      alert(
        error instanceof Error
          ? `Could not open the video: ${error.message}`
          : "Could not open the selected video.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function runAiWorker(match: Match, firstServeSeconds = currentTime) {
    if (!match.court_calibration?.confirmed || match.court_calibration.points.length !== 4) {
      return alert("Set and confirm the four court corners before running the AI worker.");
    }
    if (!match.video_url || match.video_url.startsWith("blob:")) {
      return alert("Wait until the Vercel Blob upload finishes before running AI worker analysis.");
    }

    setAnalyzing(true);
    setAnalyzeStatus("Sending match to AI worker...");
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          match_id: match.id,
          title: match.title,
          opponent: match.opponent,
          video_url: match.video_url,
          duration_seconds: match.duration_seconds,
          first_serve_seconds: firstServeSeconds,
          court_points: match.court_calibration.points,
          court_frame_time: match.court_calibration.frame_time,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "AI worker failed");

      const updated = {
        ...match,
        status: `AI analyzed: ${data.model_version || "worker"}`,
        rallies: data.rallies || [],
      };
      setSelected(updated);
      setMatches((prev) => prev.map((m) => (m.id === match.id ? updated : m)));
      setAnalyzeStatus(data.message || "AI worker analysis complete. Review and correct the tags.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI worker failed";
      setAnalyzeStatus(message);
      alert(message);
    } finally {
      setAnalyzing(false);
    }
  }

  async function deleteMatch(match: Match) {
    if (!confirm(`Remove "${match.title}" from this app and Vercel Blob?`)) return;
    try {
      await fetch("/api/blob-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: match.video_url }),
      });
    } catch (err) {
      console.warn("Blob delete failed; removing local metadata anyway", err);
    }
    const remaining = matches.filter((m) => m.id !== match.id);
    setMatches(remaining);
    if (selected?.id === match.id) setSelected(remaining[0] || null);
    setPlaybackMode("normal");
  }

  function clearVideoLibrary() {
    if (!confirm("Remove all saved match references from this browser? This does not delete cloud files.")) return;
    setMatches([]);
    setSelected(null);
    setPlaybackMode("normal");
  }

  function addManualTouch() {
    if (!selected) return;
    const start = videoRef.current?.currentTime || 0;
    const rosterHit = roster.find((p) => `#${p.number}` === tagPlayer || p.number === tagPlayer.replace("#", ""));
    const player = rosterHit ? playerText(rosterHit) : tagPlayer;
    const rally = sortedRallies.find((r) => start >= r.start_time && start <= r.end_time);
    const touch: Touch = {
      id: Date.now(),
      rally_id: rally?.id || Date.now() + 1,
      start_time: start,
      end_time: Math.min(selected.duration_seconds, start + 2),
      action: tagAction,
      player,
      outcome: tagOutcome,
      notes: rosterHit ? `Manual tag. Body-build note: ${rosterHit.build}` : "Manual tag",
      confidence: 1,
    };

    let updatedRallies: Rally[];
    if (rally) {
      updatedRallies = selected.rallies.map((r) =>
        r.id === rally.id ? { ...r, touches: [...r.touches, touch].sort((a, b) => a.start_time - b.start_time) } : r,
      );
    } else {
      updatedRallies = [
        ...selected.rallies,
        {
          id: touch.rally_id,
          match_id: selected.id,
          start_time: start,
          end_time: Math.min(selected.duration_seconds, start + 10),
          phase: "Manual rally",
          result: tagOutcome,
          confidence: 1,
          touches: [touch],
        },
      ].sort((a, b) => a.start_time - b.start_time);
    }
    const updated = { ...selected, rallies: updatedRallies };
    setSelected(updated);
    setMatches((prev) => prev.map((m) => (m.id === selected.id ? updated : m)));
  }

  function playPlaylist(rallies: Rally[], mode: PlaybackMode) {
    if (!selected || !rallies.length || !videoRef.current) return alert("No rallies yet. Upload a video or add a manual tag.");
    setActivePlaylist(rallies);
    setPlaylistIndex(0);
    setPlaybackMode(mode);
    setCurrentRallyId(rallies[0].id);
    videoRef.current.currentTime = rallies[0].start_time;
    videoRef.current.play();
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      if (playbackMode === "normal" || !activePlaylist.length) return;
      const current = activePlaylist[playlistIndex];
      if (!current) return;
      if (video.currentTime >= current.end_time) {
        const nextIndex = playlistIndex + 1;
        if (nextIndex >= activePlaylist.length) {
          video.pause();
          setPlaybackMode("normal");
          return;
        }
        const next = activePlaylist[nextIndex];
        setPlaylistIndex(nextIndex);
        setCurrentRallyId(next.id);
        video.currentTime = next.start_time;
        video.play();
      }
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [playbackMode, activePlaylist, playlistIndex]);

  const actionStats = allTouches.reduce<Record<string, number>>((acc, e) => {
    acc[e.action] = (acc[e.action] || 0) + 1;
    return acc;
  }, {});
  const playerStats = allTouches.reduce<Record<string, number>>((acc, e) => {
    acc[e.player] = (acc[e.player] || 0) + 1;
    return acc;
  }, {});
  const rallySeconds = sortedRallies.reduce((sum, e) => sum + Math.max(0, e.end_time - e.start_time), 0);
  const deadTimeRemoved = Math.max(0, (selected?.duration_seconds || 0) - rallySeconds);

  return (
    <main className="min-h-screen p-6">
      <section className="mx-auto max-w-7xl">
        <div className="mb-8 rounded-3xl bg-gradient-to-r from-blue-600 to-cyan-500 p-8 shadow-2xl">
          <p className="text-sm uppercase tracking-widest text-blue-100">Volleyball AI Video Analysis</p>
          <h1 className="mt-2 text-5xl font-black">VolleyVision AI</h1>
          <p className="mt-3 max-w-3xl text-blue-50">Cloud-storage mode: full match files upload to Vercel Blob, while rally sequences, player-role estimates, live event tracking, and correction tools stay in the app.</p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
          <aside className="space-y-6">
            <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10">
              <h2 className="text-xl font-bold">Upload video</h2>
              <input className="mt-4 w-full rounded bg-white/10 p-2" value={title} onChange={(e) => setTitle(e.target.value)} />
              <input className="mt-3 w-full rounded bg-white/10 p-2" value={opponent} onChange={(e) => setOpponent(e.target.value)} />
              <input className="mt-3 w-full" type="file" accept="video/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
              {file && <p className="mt-2 text-xs text-white/60">Selected: {file.name} · {bytesToSize(file.size)}</p>}
              {(loading || uploadProgress > 0) && (
                <div className="mt-4">
                  <div className="mb-1 flex justify-between text-xs text-white/70"><span>{uploadStatus}</span><span>{uploadProgress}%</span></div>
                  <div className="h-3 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-cyan-400 transition-all" style={{ width: `${uploadProgress}%` }} /></div>{uploadSpeed && <p className="mt-1 text-xs text-white/50">{uploadSpeed}</p>}
                </div>
              )}
              <button onClick={upload} disabled={loading} className="mt-4 w-full rounded-xl bg-cyan-400 px-4 py-3 font-bold text-slate-950 hover:bg-cyan-300 disabled:opacity-60">
                {loading ? "Uploading to Blob..." : "Upload + Process"}
              </button>
              <p className="mt-3 text-xs text-white/50">{storageMessage}</p>
              <p className="mt-1 text-xs text-white/40">Videos are stored in Vercel Blob and only URLs/metadata are saved in this browser. During upload, the app uses the local file for instant preview so playback starts faster.</p>
            </div>

            <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10">
              <h2 className="text-xl font-bold">Roster / role hints</h2>
              <p className="mt-1 text-sm text-white/60">Add each player plus role. The estimator uses this to assign pass/set/attack/block touches inside each rally.</p>
              <div className="mt-3 space-y-2">
                {roster.map((p, i) => (
                  <div key={i} className="grid grid-cols-[56px_1fr] gap-2 rounded-xl bg-white/5 p-2">
                    <input className="rounded bg-white/10 p-2" value={p.number} onChange={(e) => setRoster((r) => r.map((x, idx) => (idx === i ? { ...x, number: e.target.value } : x)))} placeholder="#" />
                    <input className="rounded bg-white/10 p-2" value={p.name} onChange={(e) => setRoster((r) => r.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)))} placeholder="Name" />
                    <input className="rounded bg-white/10 p-2 text-sm" value={p.role} onChange={(e) => setRoster((r) => r.map((x, idx) => (idx === i ? { ...x, role: e.target.value } : x)))} placeholder="setter/libero/outside" />
                    <input className="rounded bg-white/10 p-2 text-sm" value={p.build} onChange={(e) => setRoster((r) => r.map((x, idx) => (idx === i ? { ...x, build: e.target.value } : x)))} placeholder="body build" />
                  </div>
                ))}
              </div>
              <button onClick={() => setRoster([...roster, { number: "", name: "", build: "", role: "" }])} className="mt-3 w-full rounded-xl bg-white/15 px-4 py-2 font-bold hover:bg-white/25">Add player</button>
            </div>

            <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10">
              <div className="flex items-center justify-between"><h2 className="text-xl font-bold">Matches</h2><button onClick={clearVideoLibrary} className="text-xs text-red-200 hover:text-red-100">Clear list</button></div>
              <div className="mt-3 space-y-2">
                {matches.map((m) => (
                  <div key={m.id} className={`rounded-xl p-3 ${selected?.id === m.id ? "bg-cyan-400 text-slate-950" : "bg-white/10"}`}>
                    <button onClick={() => setSelected(m)} className="w-full text-left font-bold">{m.title}</button>
                    <p className="text-sm opacity-80">{m.status} · {m.rallies.length} rallies · {bytesToSize(m.file_size)}</p>{typeof m.upload_progress === "number" && m.upload_progress > 0 && m.upload_progress < 100 && <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/20"><div className="h-full bg-cyan-300" style={{ width: `${m.upload_progress}%` }} /></div>}
                    <button onClick={() => deleteMatch(m)} className="mt-2 rounded bg-red-500/80 px-3 py-1 text-xs font-bold text-white hover:bg-red-500">Delete cloud video</button>
                  </div>
                ))}
              </div>
            </div>
          </aside>

          <section className="space-y-6">
            {!selected ? (
              <div className="rounded-2xl bg-white/10 p-12 text-center ring-1 ring-white/10">Upload a video to get started.</div>
            ) : (
              <>
                <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div><h2 className="text-2xl font-black">{selected.title}</h2><p className="text-white/70">vs {selected.opponent} · {formatTime(selected.duration_seconds)} · {selected.status}</p></div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={beginCourtCalibration} className="rounded-xl bg-amber-300 px-4 py-2 font-bold text-slate-950 hover:bg-amber-200">{courtConfirmed ? "Edit court" : "Set court"}</button>
                      <button disabled={analyzing || selected.video_url.startsWith("blob:") || !courtConfirmed} onClick={() => runAiWorker(selected, currentTime)} className="rounded-xl bg-purple-400 px-4 py-2 font-bold text-slate-950 hover:bg-purple-300 disabled:opacity-50">{analyzing ? "AI analyzing..." : "Run AI worker from current time"}</button>
                      <button disabled={!top5Rallies.length} onClick={() => playPlaylist(top5Rallies, "top5")} className="rounded-xl bg-cyan-400 px-4 py-2 font-bold text-slate-950 hover:bg-cyan-300 disabled:opacity-50">Preview top 5 rallies</button>
                      <button disabled={!sortedRallies.length} onClick={() => playPlaylist(sortedRallies, "rally-only")} className="rounded-xl bg-green-400 px-4 py-2 font-bold text-slate-950 hover:bg-green-300 disabled:opacity-50">Play rally-only</button>
                      {playbackMode !== "normal" && <button onClick={() => setPlaybackMode("normal")} className="rounded-xl bg-white/15 px-4 py-2 font-bold hover:bg-white/25">Stop smart playback</button>}
                    </div>
                  </div>
                  <div className="relative mt-5 overflow-hidden rounded-xl bg-black">
                    <video ref={videoRef} className="block w-full bg-black" controls={!courtCalibrationMode} playsInline preload="metadata" src={selected.local_preview_url || selected.video_url} />
                    {(courtCalibrationMode || courtPoints.length > 0) && (
                      <div
                        className={`absolute inset-0 ${courtCalibrationMode ? "cursor-crosshair" : "pointer-events-none"}`}
                        onClick={addCourtCorner}
                      >
                        <svg className="h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none">
                          {courtPoints.length >= 2 && (
                            <polyline
                              points={[...courtPoints, ...(courtPoints.length === 4 ? [courtPoints[0]] : [])].map((point) => `${point.x},${point.y}`).join(" ")}
                              fill={courtPoints.length === 4 ? "rgba(34,211,238,0.14)" : "none"}
                              stroke="rgb(34,211,238)"
                              strokeWidth="0.006"
                              vectorEffect="non-scaling-stroke"
                            />
                          )}
                          {courtPoints.map((point, index) => (
                            <g key={`${index}-${point.x}-${point.y}`}>
                              <circle
                                cx={point.x}
                                cy={point.y}
                                r="0.018"
                                fill="rgb(250,204,21)"
                                stroke="white"
                                strokeWidth="0.004"
                                vectorEffect="non-scaling-stroke"
                                className={courtCalibrationMode ? "cursor-grab active:cursor-grabbing" : ""}
                                onClick={(event) => event.stopPropagation()}
                                onPointerDown={(event) => startCornerDrag(index, event)}
                                onPointerMove={(event) => dragCorner(index, event)}
                                onPointerUp={stopCornerDrag}
                                onPointerCancel={stopCornerDrag}
                              />
                              <text x={point.x} y={point.y - 0.028} textAnchor="middle" fill="white" fontSize="0.035" fontWeight="800">{index + 1}</text>
                            </g>
                          ))}
                        </svg>
                      </div>
                    )}
                  </div>
                  {courtCalibrationMode && (
                    <div className="mt-3 rounded-xl bg-amber-950/50 p-4 ring-1 ring-amber-300/30">
                      <div className="font-bold text-amber-100">Court calibration · {courtPoints.length}/4 corners selected</div>
                      <p className="mt-1 text-sm text-amber-100/75">Click the four outer court corners in order around the court. After four clicks, drag any numbered point to adjust it.</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button onClick={resetCourtCalibration} className="rounded-lg bg-white/15 px-3 py-2 text-sm font-bold hover:bg-white/25">Reset corners</button>
                        <button onClick={() => { setCourtCalibrationMode(false); setCourtPoints(selected.court_calibration?.points || []); setCourtConfirmed(Boolean(selected.court_calibration?.confirmed)); }} className="rounded-lg bg-white/15 px-3 py-2 text-sm font-bold hover:bg-white/25">Cancel</button>
                        <button disabled={courtPoints.length !== 4} onClick={confirmCourtCalibration} className="rounded-lg bg-cyan-300 px-3 py-2 text-sm font-bold text-slate-950 hover:bg-cyan-200 disabled:opacity-40">Confirm court</button>
                      </div>
                    </div>
                  )}
                  {!courtCalibrationMode && courtConfirmed && (
                    <p className="mt-2 text-sm font-semibold text-cyan-200">Court calibrated. The four normalized corner points will be sent with AI analysis.</p>
                  )}
                  <div className="mt-3 rounded-xl bg-purple-950/40 p-3 text-sm text-purple-100 ring-1 ring-purple-300/20">
                    <strong>AI worker:</strong> {analyzeStatus}. First set and confirm the four court corners. Then scrub to the first real serve and click <strong>Run AI worker from current time</strong>. The court points are saved with the match and sent as normalized coordinates.
                  </div>
                  <div className="mt-4 rounded-xl bg-slate-950/50 p-4 ring-1 ring-white/10">
                    <div className="text-sm uppercase tracking-widest text-cyan-200">Live tracker · {formatTime(currentTime)}</div>
                    <div className="mt-2 text-2xl font-black">{activeTouch ? `${activeTouch.action}: ${activeTouch.player}` : "No active touch yet"}</div>
                    <div className="text-white/70">{activeRally ? `${activeRally.phase} → ${activeRally.result}` : "Press play to follow the breakdown."}</div>
                  </div>
                </div>

                <div className="grid gap-6 md:grid-cols-4">
                  <Stat label="Rallies" value={String(sortedRallies.length)} />
                  <Stat label="Touches/actions" value={String(allTouches.length)} />
                  <Stat label="Active play" value={formatTime(rallySeconds)} />
                  <Stat label="Dead time skipped" value={formatTime(deadTimeRemoved)} />
                </div>

                <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10">
                  <h2 className="text-xl font-bold">Add touch at current video time</h2>
                  <div className="mt-3 grid gap-2 md:grid-cols-4">
                    <input className="rounded bg-white/10 p-2" value={tagPlayer} onChange={(e) => setTagPlayer(e.target.value)} placeholder="#12" />
                    <input className="rounded bg-white/10 p-2" value={tagAction} onChange={(e) => setTagAction(e.target.value)} placeholder="attack" />
                    <input className="rounded bg-white/10 p-2" value={tagOutcome} onChange={(e) => setTagOutcome(e.target.value)} placeholder="kill" />
                    <button onClick={addManualTouch} className="rounded-xl bg-white/15 px-4 py-2 font-bold hover:bg-white/25">Add live-tracked touch</button>
                  </div>
                </div>

                <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10">
                  <h2 className="text-xl font-bold">Player/event summary</h2>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <Summary title="Actions by type" data={actionStats} />
                    <Summary title="Estimated/manual players" data={playerStats} />
                  </div>
                </div>

                <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10">
                  <h2 className="text-xl font-bold">Live rally breakdown</h2>
                  <p className="mt-1 text-sm text-white/60">This list follows the video. The current touch stays highlighted and scrolls into view. Click any row to jump there.</p>
                  <div className="mt-4 max-h-[560px] overflow-auto rounded-xl border border-white/10">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-slate-900 text-left"><tr><th className="p-3">Time</th><th>Rally</th><th>Action sequence</th><th>Player</th><th>Outcome</th><th>Confidence</th></tr></thead>
                      <tbody>
                        {sortedRallies.map((r) =>
                          r.touches.map((t, idx) => (
                            <tr ref={currentTouchId === t.id ? activeRowRef : null} key={t.id} onClick={() => jumpToTime(t.start_time)} title={t.notes} className={`cursor-pointer border-t border-white/10 hover:bg-cyan-400/20 ${currentTouchId === t.id ? "bg-cyan-400/40" : currentRallyId === r.id ? "bg-cyan-400/10" : ""}`}>
                              <td className="p-3 font-bold text-cyan-200">{formatTime(t.start_time)}</td>
                              <td>{idx === 0 ? <button onClick={(e) => { e.stopPropagation(); jumpToTime(r.start_time); }} className="rounded bg-white/10 px-2 py-1 text-xs font-bold hover:bg-white/20">{formatTime(r.start_time)}-{formatTime(r.end_time)}</button> : ""}</td>
                              <td><span className="capitalize font-bold">{t.action}</span>{idx === 0 && <span className="ml-2 text-white/50">({r.phase})</span>}</td>
                              <td>{t.player}</td>
                              <td>{t.outcome}</td>
                              <td>{Math.round(t.confidence * 100)}%</td>
                            </tr>
                          )),
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl bg-white/10 p-5 ring-1 ring-white/10"><div className="text-3xl font-black">{value}</div><div className="text-white/70">{label}</div></div>;
}

function Summary({ title, data }: { title: string; data: Record<string, number> }) {
  return (
    <div className="rounded-xl bg-white/5 p-3">
      <div className="font-bold">{title}</div>
      {Object.entries(data).slice(0, 12).map(([k, v]) => (
        <div key={k} className="mt-1 flex justify-between"><span>{k}</span><span>{v}</span></div>
      ))}
    </div>
  );
}