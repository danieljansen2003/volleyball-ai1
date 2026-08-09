"use client";

import { upload as uploadToBlob } from "@vercel/blob/client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";

type CourtPoint = { x: number; y: number };
type CourtCalibration = { points: CourtPoint[]; confirmed: boolean; frame_time: number };
type BallLabelBox = { x: number; y: number; width: number; height: number };

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
  source?: string;
  reviewed?: boolean;
  track_id?: number | null;
  ball_frame?: number | null;
  features?: Record<string, number> | null;
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

type TrackingPlayer = {
  track_id: number;
  confidence: number;
  box: { x1: number; y1: number; x2: number; y2: number };
  foot: { x: number; y: number };
};

type TrackingBall = {
  confidence: number;
  box: { x1: number; y1: number; x2: number; y2: number };
  center: { x: number; y: number };
};

type TrackingFrame = {
  frame: number;
  timestamp_seconds: number;
  players: TrackingPlayer[];
  balls?: TrackingBall[];
};

type TrackingResult = {
  status: string;
  device: string;
  fps: number;
  width: number;
  height: number;
  frame_count: number;
  reported_frame_count: number;
  duration_seconds: number;
  unique_track_count: number;
  raw_unique_track_count?: number;
  stitched_track_count?: number;
  ball_detections?: number;
  tracker?: string;
  detections_total: number;
  detections_inside_court: number;
  detections_removed_outside_court: number;
  detections_removed_short_track: number;
  detections_kept: number;
  track_lengths: Record<string, number>;
  frames: TrackingFrame[];
};

type TrackingSummary = Pick<
  TrackingResult,
  | "unique_track_count"
  | "detections_total"
  | "detections_inside_court"
  | "detections_removed_outside_court"
  | "detections_removed_short_track"
  | "detections_kept"
  | "frame_count"
  | "fps"
>;

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
  storage_provider: "vercel-blob" | "local";
  court_calibration?: CourtCalibration;
  tracking_summary?: TrackingSummary;
};

type RosterPlayer = { number: string; name: string; build: string; role: string };

type JobResponse = {
  job_id: string;
  status: "queued" | "processing" | "complete" | "failed";
  progress: number;
  message: string;
  error?: string | null;
  result?: {
    status: string;
    message: string;
    model_version: string;
    rallies: Rally[];
    tracking?: TrackingResult;
    action_diagnostics?: { ball_observations?: number; contact_candidates?: number; message?: string };
  } | null;
};

const IS_LOCAL_MODE = process.env.NEXT_PUBLIC_VV_MODE === "local";
const MATCH_LIBRARY_KEY = IS_LOCAL_MODE ? "volleyvision-local-matches-v1" : "volleyvision-cloud-matches-v2";
const BALL_LABELS_ENDPOINT = IS_LOCAL_MODE ? "/api/local-ball-labels" : "/api/ball-labels";
const TRAINING_FEEDBACK_ENDPOINT = IS_LOCAL_MODE ? "/api/local-training-feedback" : "/api/training-feedback";
const ROSTER_KEY = "volleyvision-roster-v3";
const MAX_METADATA_MATCHES = 50;
const MAX_CLIENT_UPLOAD_BYTES = 25 * 1024 * 1024 * 1024;

function bytesToSize(bytes = 0) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
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

function trackingSummary(tracking: TrackingResult): TrackingSummary {
  return {
    unique_track_count: tracking.unique_track_count,
    detections_total: tracking.detections_total,
    detections_inside_court: tracking.detections_inside_court,
    detections_removed_outside_court: tracking.detections_removed_outside_court,
    detections_removed_short_track: tracking.detections_removed_short_track,
    detections_kept: tracking.detections_kept,
    frame_count: tracking.frame_count,
    fps: tracking.fps,
  };
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const uploadStartedAtRef = useRef(0);
  const localPreviewUrlsRef = useRef<string[]>([]);
  const pollCancelledRef = useRef(false);
  const ballDragStartRef = useRef<CourtPoint | null>(null);

  const [matches, setMatches] = useState<Match[]>([]);
  const [libraryReady, setLibraryReady] = useState(false);
  const [selected, setSelected] = useState<Match | null>(null);
  const [title, setTitle] = useState("Varsity Match");
  const [opponent, setOpponent] = useState("Opponent");
  const [file, setFile] = useState<File | null>(null);
  const [storageMessage, setStorageMessage] = useState(IS_LOCAL_MODE ? "LOCAL TRAINING MODE · videos and labels stay on this Mac." : "Videos upload to Vercel Blob and stay out of Git.");

  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState("Idle");
  const [uploadSpeed, setUploadSpeed] = useState("");

  const [courtPoints, setCourtPoints] = useState<CourtPoint[]>([]);
  const [courtCalibrationMode, setCourtCalibrationMode] = useState(false);
  const [courtConfirmed, setCourtConfirmed] = useState(false);

  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState(0);
  const [analyzeStatus, setAnalyzeStatus] = useState("AI worker not run yet");
  const [tracking, setTracking] = useState<TrackingResult | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [feedbackStatus, setFeedbackStatus] = useState("Review AI action candidates below.");
  const [ballLabelMode, setBallLabelMode] = useState(false);
  const [ballLabelBox, setBallLabelBox] = useState<BallLabelBox | null>(null);
  const [ballLabelSaving, setBallLabelSaving] = useState(false);
  const [ballLabelStatus, setBallLabelStatus] = useState("Pause on a clear frame, draw a tight box around the volleyball, then save it.");
  const [ballTrainingCount, setBallTrainingCount] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);

  const [tagPlayer, setTagPlayer] = useState("#12");
  const [tagAction, setTagAction] = useState("attack");
  const [tagOutcome, setTagOutcome] = useState("kill");
  const [roster, setRoster] = useState<RosterPlayer[]>([
    { number: "8", name: "Player 8", build: "outside/right-side build", role: "outside hitter" },
    { number: "12", name: "Player 12", build: "middle blocker build", role: "middle blocker" },
    { number: "1", name: "Player 1", build: "setter build", role: "setter" },
    { number: "2", name: "Player 2", build: "passer/libero build", role: "passer/libero" },
    { number: "3", name: "Player 3", build: "defensive build", role: "defensive specialist" },
    { number: "4", name: "Player 4", build: "outside hitter build", role: "hitter" },
  ]);

  useEffect(() => {
    const savedRoster = window.localStorage.getItem(ROSTER_KEY);
    if (savedRoster) {
      try { setRoster(JSON.parse(savedRoster)); } catch { /* ignore corrupt local data */ }
    }
    const restored = readMatchLibrary();
    setMatches(restored);
    setSelected(restored[0] || null);
    setLibraryReady(true);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(ROSTER_KEY, JSON.stringify(roster));
  }, [roster]);

  useEffect(() => {
    fetch(BALL_LABELS_ENDPOINT, { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => { if (data?.ok) setBallTrainingCount(Number(data.count || 0)); })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!ballLabelMode) return;

    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const video = videoRef.current;
      if (!video) return;

      if (event.code === "Space") {
        event.preventDefault();
        if (video.paused) void video.play(); else video.pause();
      } else if (event.code === "ArrowRight") {
        event.preventDefault();
        video.pause();
        const fps = tracking?.fps || 30;
        video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 1 / fps);
      } else if (event.code === "ArrowLeft") {
        event.preventDefault();
        video.pause();
        const fps = tracking?.fps || 30;
        video.currentTime = Math.max(0, video.currentTime - 1 / fps);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [ballLabelMode, tracking?.fps]);

  useEffect(() => {
    if (!libraryReady) return;
    saveMatchLibrary(matches);
    const total = matches.reduce((sum, match) => sum + (match.file_size || 0), 0);
    setStorageMessage(IS_LOCAL_MODE ? `${matches.length} local videos · ${bytesToSize(total)} on this Mac · 0 Blob operations` : `${matches.length} cloud videos · ${bytesToSize(total)} referenced from Vercel Blob`);
  }, [matches, libraryReady]);

  useEffect(() => () => {
    pollCancelledRef.current = true;
    localPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => {
    pollCancelledRef.current = true;
    setTracking(null);
    setAnalyzeProgress(0);
    setAnalyzeStatus(selected?.tracking_summary ? "Previous tracking summary loaded. Re-run AI to restore video overlay." : "AI worker not run yet");
    const savedPoints = selected?.court_calibration?.points;
    setCourtPoints(Array.isArray(savedPoints) ? savedPoints.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y)).slice(0, 4) : []);
    setCourtConfirmed(Boolean(selected?.court_calibration?.confirmed));
    setCourtCalibrationMode(false);
    setBallLabelMode(false);
    setBallLabelBox(null);
    ballDragStartRef.current = null;
  }, [selected?.id]);

  const sortedRallies = useMemo(
    () => [...(selected?.rallies || [])].sort((a, b) => a.start_time - b.start_time),
    [selected],
  );
  const allTouches = useMemo(
    () => sortedRallies.flatMap((rally) => rally.touches).sort((a, b) => a.start_time - b.start_time),
    [sortedRallies],
  );

  const currentTrackingFrame = useMemo(() => {
    if (!tracking?.frames.length) return null;
    const estimatedIndex = Math.round(currentTime * tracking.fps);
    const clamped = Math.max(0, Math.min(tracking.frames.length - 1, estimatedIndex));
    return tracking.frames[clamped] || null;
  }, [tracking, currentTime]);

  function updateMatch(updated: Match) {
    setSelected(updated);
    setMatches((previous) => previous.map((match) => (match.id === updated.id ? updated : match)));
  }

  async function saveTrainingFeedback(original: Touch, corrected: Touch) {
    if (!selected) return;
    try {
      setFeedbackStatus("Saving reviewed label to the training set...");
      const response = await fetch(TRAINING_FEEDBACK_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_version: 1,
          created_at: new Date().toISOString(),
          match_id: selected.id,
          title: selected.title,
          opponent: selected.opponent,
          video_url: selected.video_url,
          filename: selected.filename,
          court_calibration: selected.court_calibration,
          touch_id: corrected.id,
          clip: { start_time: corrected.start_time, end_time: corrected.end_time },
          model_version: selected.status.startsWith("AI analyzed: ") ? selected.status.replace("AI analyzed: ", "") : "manual",
          original_prediction: {
            action: original.action,
            player: original.player,
            outcome: original.outcome,
            confidence: original.confidence,
            track_id: original.track_id,
            features: original.features,
          },
          corrected_label: {
            action: corrected.action,
            player: corrected.player,
            outcome: corrected.outcome,
            track_id: corrected.track_id,
          },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save training label.");
      setFeedbackStatus("Saved. This reviewed example is now in your training-feedback dataset.");
    } catch (error) {
      setFeedbackStatus(error instanceof Error ? `Label saved locally, but cloud training save failed: ${error.message}` : "Cloud training save failed.");
    }
  }

  async function reviewTouch(original: Touch, changes: Partial<Touch>) {
    if (!selected) return;
    const corrected: Touch = { ...original, ...changes, reviewed: true };
    const rallies = selected.rallies.map((rally) => ({
      ...rally,
      touches: rally.touches.map((touch) => touch.id === original.id ? corrected : touch),
    }));
    updateMatch({ ...selected, rallies });
    await saveTrainingFeedback(original, corrected);
  }

  function toggleBallLabelPlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play(); else video.pause();
  }

  function seekBallLabelVideo(value: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(video.duration || value, value));
  }

  function stepBallLabelFrame(direction: -1 | 1) {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    const fps = tracking?.fps || 30;
    const next = video.currentTime + direction * (1 / fps);
    video.currentTime = Math.max(0, Math.min(video.duration || next, next));
  }

  function beginBallLabeling() {
    if (!selected || !videoRef.current) return;
    videoRef.current.pause();
    setCourtCalibrationMode(false);
    setBallLabelMode(true);
    setBallLabelBox(null);
    ballDragStartRef.current = null;
    setBallLabelStatus("Drag a tight rectangle around the volleyball on this paused frame.");
  }

  function normalizedPointFromElement(event: { clientX: number; clientY: number }, element: HTMLElement): CourtPoint {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
    };
  }

  function startBallBox(event: React.PointerEvent<HTMLDivElement>) {
    if (!ballLabelMode) return;
    videoRef.current?.pause();
    event.preventDefault();
    const point = normalizedPointFromElement(event, event.currentTarget);
    ballDragStartRef.current = point;
    setBallLabelBox({ x: point.x, y: point.y, width: 0, height: 0 });
  }

  function updateBallBox(event: React.PointerEvent<HTMLDivElement>) {
    const start = ballDragStartRef.current;
    if (!ballLabelMode || !start) return;
    const end = normalizedPointFromElement(event, event.currentTarget);
    setBallLabelBox({
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    });
  }

  function finishBallBox(event: React.PointerEvent<HTMLDivElement>) {
    if (!ballLabelMode || !ballDragStartRef.current) return;
    updateBallBox(event);
    ballDragStartRef.current = null;
  }

  async function saveBallLabel() {
    if (!selected || !videoRef.current || !ballLabelBox) return;
    if (ballLabelBox.width < 0.002 || ballLabelBox.height < 0.002) {
      return alert("Draw a box around the volleyball first.");
    }

    const video = videoRef.current;
    if (!video.videoWidth || !video.videoHeight) return alert("Video frame is not ready yet.");

    setBallLabelSaving(true);
    setBallLabelStatus("Saving frame + YOLO label to the training dataset...");
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not create frame canvas.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not encode frame image.")), "image/jpeg", 0.94);
      });

      const sampleId = `${selected.id}-${Math.round(video.currentTime * 1000)}-${Date.now()}`;
      const form = new FormData();
      form.append("image", new File([blob], `${sampleId}.jpg`, { type: "image/jpeg" }));
      form.append("match_id", String(selected.id));
      form.append("sample_id", sampleId);
      form.append("timestamp_seconds", String(video.currentTime));
      form.append("video_url", selected.video_url);
      form.append("filename", selected.filename);
      form.append("frame_width", String(video.videoWidth));
      form.append("frame_height", String(video.videoHeight));
      form.append("x", String(ballLabelBox.x));
      form.append("y", String(ballLabelBox.y));
      form.append("width", String(ballLabelBox.width));
      form.append("height", String(ballLabelBox.height));

      const response = await fetch(BALL_LABELS_ENDPOINT, { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save ball label.");
      setBallTrainingCount((count) => count + 1);
      setBallLabelStatus(`Saved training sample #${ballTrainingCount + 1}. Move to another frame and label the ball again.`);
      setBallLabelBox(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save ball label.";
      setBallLabelStatus(message);
      alert(message);
    } finally {
      setBallLabelSaving(false);
    }
  }

  function beginCourtCalibration() {
    if (!selected || !videoRef.current) return;
    videoRef.current.pause();
    setBallLabelMode(false);
    setBallLabelBox(null);
    setCourtCalibrationMode(true);
    setCourtConfirmed(false);
    setCourtPoints([]);
    setTracking(null);
  }

  function resetCourtCalibration() {
    setCourtPoints([]);
    setCourtConfirmed(false);
    setCourtCalibrationMode(true);
    setTracking(null);
  }

  function normalizedPointFromClick(
    event: MouseEvent<HTMLDivElement>,
  ): CourtPoint {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
    };
  }

  function addCourtCorner(event: MouseEvent<HTMLDivElement>) {
    if (!courtCalibrationMode || courtPoints.length >= 4) return;
    const point = normalizedPointFromClick(event);
    setCourtPoints((points) => [...points, point]);
  }

  function confirmCourtCalibration() {
    if (!selected || courtPoints.length !== 4) return alert("Select all four court corners first.");
    const calibration: CourtCalibration = {
      points: courtPoints,
      confirmed: true,
      frame_time: videoRef.current?.currentTime || currentTime,
    };
    updateMatch({ ...selected, court_calibration: calibration, tracking_summary: undefined });
    setCourtConfirmed(true);
    setCourtCalibrationMode(false);
    setTracking(null);
  }

  async function upload() {
    if (!file) return alert("Choose a video first.");
    if (file.size > MAX_CLIENT_UPLOAD_BYTES) return alert(`File is too large: ${bytesToSize(file.size)}.`);

    setLoading(true);
    setUploadProgress(0);
    setUploadSpeed("");
    setUploadStatus("Preparing local preview...");

    const matchId = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const pathname = `matches/${matchId}-${safeName}`;
    let localPreviewUrl = "";

    try {
      localPreviewUrl = URL.createObjectURL(file);
      localPreviewUrlsRef.current.push(localPreviewUrl);
      const probe = document.createElement("video");
      probe.preload = "metadata";
      probe.src = localPreviewUrl;
      const duration = await new Promise<number>((resolve) => {
        let done = false;
        const finish = (value: number) => { if (!done) { done = true; resolve(value); } };
        probe.onloadedmetadata = () => finish(Number.isFinite(probe.duration) ? probe.duration : 0);
        probe.onerror = () => finish(0);
        window.setTimeout(() => finish(0), 3000);
      });

      const localMatch: Match = {
        id: matchId,
        title,
        opponent,
        status: "local preview ready",
        duration_seconds: duration > 0 ? duration : 60 * 60,
        created_at: new Date().toISOString(),
        rallies: [],
        video_url: localPreviewUrl,
        local_preview_url: localPreviewUrl,
        upload_progress: 0,
        filename: file.name,
        file_size: file.size,
        storage_provider: IS_LOCAL_MODE ? "local" : "vercel-blob",
      };

      setMatches((previous) => [localMatch, ...previous].slice(0, MAX_METADATA_MATCHES));
      setSelected(localMatch);
      setTracking(null);
      setCourtPoints([]);
      setCourtConfirmed(false);

      uploadStartedAtRef.current = Date.now();

      if (IS_LOCAL_MODE) {
        setUploadStatus("Saving full match to this Mac...");
        const form = new FormData();
        form.append("file", file);
        form.append("match_id", String(matchId));
        const response = await fetch("/api/local-upload", { method: "POST", body: form });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not save video locally.");
        const savedMatch: Match = {
          ...localMatch,
          status: "saved locally",
          video_url: data.url,
          local_preview_url: localPreviewUrl,
          upload_progress: 100,
          storage_provider: "local",
        };
        setUploadProgress(100);
        setUploadStatus("Saved locally. Set the court, then run AI. No Blob usage.");
        setSelected(savedMatch);
        setMatches((previous) => previous.map((match) => (match.id === matchId ? savedMatch : match)));
      } else {
        setUploadStatus("Uploading full match to Vercel Blob...");
        try {
          const blob = await uploadToBlob(pathname, file, {
            access: "public",
            handleUploadUrl: "/api/blob-upload",
            onUploadProgress: (event) => {
              const loaded = event.loaded || 0;
              const total = event.total || file.size || 1;
              const pct = typeof event.percentage === "number"
                ? event.percentage
                : Math.round((loaded / Math.max(1, total)) * 100);
              const safePct = Math.max(1, Math.min(99, Math.round(pct)));
              const elapsed = Math.max(1, (Date.now() - uploadStartedAtRef.current) / 1000);
              setUploadProgress(safePct);
              setUploadSpeed(`${(loaded / 1024 / 1024 / elapsed).toFixed(1)} MB/s · ${bytesToSize(loaded)} / ${bytesToSize(total)}`);
              setMatches((previous) => previous.map((match) =>
                match.id === matchId ? { ...match, status: `uploading ${safePct}%`, upload_progress: safePct } : match,
              ));
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
          setUploadStatus("Upload complete. Set the court, then run AI.");
          setSelected(cloudMatch);
          setMatches((previous) => previous.map((match) => (match.id === matchId ? cloudMatch : match)));
        } catch (cloudError) {
          console.error("Cloud upload failed", cloudError);
          const localOnly = { ...localMatch, status: "local preview only — cloud upload failed" };
          setSelected(localOnly);
          setMatches((previous) => previous.map((match) => (match.id === matchId ? localOnly : match)));
          setUploadProgress(0);
          setUploadStatus("Cloud upload failed. Local preview still works.");
        }
      }
    } catch (error) {
      console.error(error);
      setUploadStatus("Could not open video.");
      alert(error instanceof Error ? error.message : "Could not open video.");
    } finally {
      setLoading(false);
    }
  }

  async function pollJob(jobId: string, match: Match) {
    pollCancelledRef.current = false;
    const started = Date.now();
    const maxWaitMs = 2 * 60 * 60 * 1000;
    let consecutivePollErrors = 0;
    const maxConsecutivePollErrors = 12;

    while (!pollCancelledRef.current && Date.now() - started < maxWaitMs) {
      await new Promise((resolve) => window.setTimeout(resolve, 10000));

      try {
        // A temporary Safari/network/Vercel polling error must NOT cancel the AI job.
        // The local Mac worker runs independently, so keep reconnecting to the job.
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 15000);

        let response: Response;
        try {
          response = await fetch(
            `/api/analyze?job_id=${encodeURIComponent(jobId)}&poll=${Date.now()}`,
            {
              cache: "no-store",
              signal: controller.signal,
              headers: { Accept: "application/json" },
            },
          );
        } finally {
          window.clearTimeout(timeoutId);
        }

        const raw = await response.text();
        let job: JobResponse & { error?: string };
        try {
          job = JSON.parse(raw) as JobResponse & { error?: string };
        } catch {
          throw new Error(
            `Status check returned non-JSON data (HTTP ${response.status}).`,
          );
        }

        if (!response.ok) {
          throw new Error(job.error || `Could not check AI job (HTTP ${response.status}).`);
        }

        consecutivePollErrors = 0;
        setAnalyzeProgress(job.progress || 0);
        setAnalyzeStatus(job.message || job.status);

        if (job.status === "failed") {
          throw new Error(job.error || "AI analysis failed.");
        }
        if (job.status !== "complete") continue;

        const result = job.result;
        if (!result?.tracking) {
          throw new Error("AI job completed without tracking data.");
        }

        setTracking(result.tracking);
        const updated: Match = {
          ...match,
          status: `AI analyzed: ${result.model_version}`,
          rallies: result.rallies || [],
          tracking_summary: trackingSummary(result.tracking),
        };
        updateMatch(updated);
        setAnalyzeProgress(100);
        setAnalyzeStatus(result.message || "AI tracking complete.");
        const candidateCount =
          result.action_diagnostics?.contact_candidates ??
          result.rallies?.flatMap((rally) => rally.touches).length ??
          0;
        setFeedbackStatus(
          candidateCount
            ? `AI proposed ${candidateCount} action candidate${candidateCount === 1 ? "" : "s"}. Review and approve/correct them below.`
            : result.action_diagnostics?.message ||
                "No action candidates found. Manual labels are still useful training data.",
        );
        return;
      } catch (error) {
        // A job that explicitly reports failure is terminal. Browser/network polling
        // failures are retried because the Mac worker may still be running normally.
        const message = error instanceof Error ? error.message : "Could not check AI job.";
        if (message === "AI analysis failed." || message.startsWith("HTTP worker failure:")) {
          throw error;
        }

        consecutivePollErrors += 1;
        console.warn(
          `AI status poll ${consecutivePollErrors}/${maxConsecutivePollErrors} failed:`,
          error,
        );

        if (consecutivePollErrors >= maxConsecutivePollErrors) {
          throw new Error(
            "Lost contact with the AI job status endpoint. The Mac worker may still be processing; refresh the page before starting another job.",
          );
        }

        setAnalyzeStatus(
          `AI is still running locally. Reconnecting to status… (${consecutivePollErrors}/${maxConsecutivePollErrors})`,
        );
      }
    }

    if (pollCancelledRef.current) return;
    throw new Error("AI job did not finish before the browser polling limit.");
  }

  async function runAiWorker(match: Match) {
    if (!match.court_calibration?.confirmed || match.court_calibration.points.length !== 4) {
      return alert("Set and confirm the four court corners before running AI.");
    }
    if (!match.video_url || match.video_url.startsWith("blob:")) {
      return alert(IS_LOCAL_MODE ? "Wait for the local video save to finish before running AI." : "Wait for the Vercel Blob upload to finish before running AI.");
    }

    pollCancelledRef.current = true;
    setAnalyzing(true);
    setAnalyzeProgress(0);
    setAnalyzeStatus(IS_LOCAL_MODE ? "Queuing local AI job on this Mac..." : "Queuing job for your local Mac AI worker...");
    setTracking(null);

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
          first_serve_seconds: currentTime,
          court_points: match.court_calibration.points,
          court_frame_time: match.court_calibration.frame_time,
        }),
      });
      const data: JobResponse & { error?: string } = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not start AI job.");
      setAnalyzeStatus(data.message || "AI job queued.");
      await pollJob(data.job_id, match);
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI worker failed.";
      setAnalyzeStatus(message);
      alert(message);
    } finally {
      setAnalyzing(false);
    }
  }

  async function deleteMatch(match: Match) {
    if (!confirm(IS_LOCAL_MODE ? `Remove "${match.title}" and its local video file?` : `Remove "${match.title}" from this app and Vercel Blob?`)) return;
    pollCancelledRef.current = true;
    try {
      if (!match.video_url.startsWith("blob:")) {
        await fetch(IS_LOCAL_MODE ? "/api/local-delete" : "/api/blob-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: match.video_url }),
        });
      }
    } catch (error) {
      console.warn(IS_LOCAL_MODE ? "Local video delete failed" : "Blob delete failed", error);
    }
    const remaining = matches.filter((item) => item.id !== match.id);
    setMatches(remaining);
    if (selected?.id === match.id) setSelected(remaining[0] || null);
  }

  async function addManualTouch() {
    if (!selected) return;
    const start = videoRef.current?.currentTime || 0;
    const rallyId = Date.now();
    const touch: Touch = {
      id: rallyId * 100,
      rally_id: rallyId,
      start_time: start,
      end_time: Math.min(selected.duration_seconds, start + 1.5),
      action: tagAction,
      player: tagPlayer,
      outcome: tagOutcome,
      notes: "Manual user tag — reviewed ground-truth training label.",
      confidence: 1,
      source: "manual",
      reviewed: true,
    };
    const rally: Rally = {
      id: rallyId,
      match_id: selected.id,
      start_time: start,
      end_time: Math.min(selected.duration_seconds, start + 8),
      phase: "Manual event",
      result: tagOutcome,
      confidence: 1,
      touches: [touch],
    };
    updateMatch({ ...selected, rallies: [...selected.rallies, rally].sort((a, b) => a.start_time - b.start_time) });
    await saveTrainingFeedback(touch, touch);
  }

  const summary = tracking ? trackingSummary(tracking) : selected?.tracking_summary;

  return (
    <main className="min-h-screen p-6">
      <section className="mx-auto max-w-7xl">
        <div className="mb-8 rounded-3xl bg-gradient-to-r from-blue-600 to-cyan-500 p-8 shadow-2xl">
          <p className="text-sm uppercase tracking-widest text-blue-100">Volleyball AI Video Analysis</p>
          <h1 className="mt-2 text-5xl font-black">VolleyVision AI</h1>
          <p className="mt-3 max-w-3xl text-blue-50">Court-filtered player tracking, built-in volleyball box labeling, a persistent YOLO ball-training dataset, and human-reviewed action labels.</p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
          <aside className="space-y-6">
            <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10">
              <h2 className="text-xl font-bold">Upload video</h2>
              <input className="mt-4 w-full rounded bg-white/10 p-2" value={title} onChange={(e) => setTitle(e.target.value)} />
              <input className="mt-3 w-full rounded bg-white/10 p-2" value={opponent} onChange={(e) => setOpponent(e.target.value)} />
              <input className="mt-3 w-full" type="file" accept="video/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
              {file && <p className="mt-2 text-xs text-white/60">{file.name} · {bytesToSize(file.size)}</p>}
              {(loading || uploadProgress > 0) && (
                <div className="mt-4">
                  <div className="mb-1 flex justify-between text-xs text-white/70"><span>{uploadStatus}</span><span>{uploadProgress}%</span></div>
                  <div className="h-3 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-cyan-400 transition-all" style={{ width: `${uploadProgress}%` }} /></div>
                  {uploadSpeed && <p className="mt-1 text-xs text-white/50">{uploadSpeed}</p>}
                </div>
              )}
              <button onClick={upload} disabled={loading} className="mt-4 w-full rounded-xl bg-cyan-400 px-4 py-3 font-bold text-slate-950 hover:bg-cyan-300 disabled:opacity-60">{loading ? "Uploading..." : "Upload + Process"}</button>
              <p className="mt-3 text-xs text-white/50">{storageMessage}</p>
            </div>

            <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10">
              <h2 className="text-xl font-bold">Roster</h2>
              <p className="mt-1 text-sm text-white/60">Roster metadata can later map stable track IDs to jersey/player identities. Tracking now uses occlusion-aware ReID plus track stitching.</p>
              <div className="mt-3 space-y-2">
                {roster.map((player, index) => (
                  <div key={index} className="grid grid-cols-[56px_1fr] gap-2 rounded-xl bg-white/5 p-2">
                    <input className="rounded bg-white/10 p-2" value={player.number} onChange={(e) => setRoster((items) => items.map((item, i) => i === index ? { ...item, number: e.target.value } : item))} placeholder="#" />
                    <input className="rounded bg-white/10 p-2" value={player.name} onChange={(e) => setRoster((items) => items.map((item, i) => i === index ? { ...item, name: e.target.value } : item))} placeholder="Name" />
                    <input className="rounded bg-white/10 p-2 text-sm" value={player.role} onChange={(e) => setRoster((items) => items.map((item, i) => i === index ? { ...item, role: e.target.value } : item))} placeholder="Role" />
                    <input className="rounded bg-white/10 p-2 text-sm" value={player.build} onChange={(e) => setRoster((items) => items.map((item, i) => i === index ? { ...item, build: e.target.value } : item))} placeholder="Build" />
                  </div>
                ))}
              </div>
              <button onClick={() => setRoster([...roster, { number: "", name: "", build: "", role: "" }])} className="mt-3 w-full rounded-xl bg-white/15 px-4 py-2 font-bold hover:bg-white/25">Add player</button>
            </div>

            <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10">
              <h2 className="text-xl font-bold">Matches</h2>
              <div className="mt-3 space-y-2">
                {matches.map((match) => (
                  <div key={match.id} className={`rounded-xl p-3 ${selected?.id === match.id ? "bg-cyan-400 text-slate-950" : "bg-white/10"}`}>
                    <button onClick={() => setSelected(match)} className="w-full text-left font-bold">{match.title}</button>
                    <p className="text-sm opacity-80">{match.status} · {bytesToSize(match.file_size)}</p>
                    <button onClick={() => deleteMatch(match)} className="mt-2 rounded bg-red-500/80 px-3 py-1 text-xs font-bold text-white">Delete</button>
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
                    <div>
                      <h2 className="text-2xl font-black">{selected.title}</h2>
                      <p className="text-white/70">vs {selected.opponent} · {formatTime(selected.duration_seconds)} · {selected.status}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={beginCourtCalibration} disabled={analyzing || ballLabelMode} className="rounded-xl bg-amber-300 px-4 py-2 font-bold text-slate-950 disabled:opacity-50">{courtConfirmed ? "Edit court" : "Set court"}</button>
                      <button onClick={beginBallLabeling} disabled={analyzing || courtCalibrationMode} className="rounded-xl bg-yellow-300 px-4 py-2 font-bold text-slate-950 disabled:opacity-50">Label volleyball</button>
                      <button disabled={analyzing || selected.video_url.startsWith("blob:") || !courtConfirmed || ballLabelMode} onClick={() => runAiWorker(selected)} className="rounded-xl bg-purple-400 px-4 py-2 font-bold text-slate-950 disabled:opacity-50">{analyzing ? `AI ${analyzeProgress}%` : "Run local AI"}</button>
                    </div>
                  </div>

                  <div className="relative mt-5 overflow-hidden rounded-xl bg-black">
                    <video
                      ref={videoRef}
                      className="block w-full bg-black"
                      controls={!courtCalibrationMode && !ballLabelMode}
                      playsInline
                      preload="metadata"
                      src={selected.local_preview_url || selected.video_url}
                      onLoadedMetadata={(e) => {
                        setVideoDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0);
                        setCurrentTime(e.currentTarget.currentTime);
                      }}
                      onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                      onPlay={() => setVideoPlaying(true)}
                      onPause={() => setVideoPlaying(false)}
                      onEnded={() => setVideoPlaying(false)}
                    />

                    {(courtCalibrationMode || ballLabelMode || courtPoints.length > 0 || currentTrackingFrame) && (
                      <div
                        className={`absolute inset-0 ${courtCalibrationMode ? "cursor-crosshair" : ballLabelMode ? "cursor-crosshair touch-none" : "pointer-events-none"}`}
                        onClick={courtCalibrationMode ? addCourtCorner : undefined}
                        onPointerDown={ballLabelMode ? startBallBox : undefined}
                        onPointerMove={ballLabelMode ? updateBallBox : undefined}
                        onPointerUp={ballLabelMode ? finishBallBox : undefined}
                        onPointerCancel={ballLabelMode ? finishBallBox : undefined}
                      >
                        <svg className="h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none">
                          {courtPoints.length >= 2 && (
                            <polyline points={[...courtPoints, ...(courtPoints.length === 4 ? [courtPoints[0]] : [])].map((point) => `${point.x},${point.y}`).join(" ")} fill={courtPoints.length === 4 ? "rgba(34,211,238,0.10)" : "none"} stroke="rgb(34,211,238)" strokeWidth="0.004" vectorEffect="non-scaling-stroke" />
                          )}

                          {tracking && currentTrackingFrame?.players.map((player) => {
                            const x = player.box.x1 / tracking.width;
                            const y = player.box.y1 / tracking.height;
                            const w = (player.box.x2 - player.box.x1) / tracking.width;
                            const h = (player.box.y2 - player.box.y1) / tracking.height;
                            return (
                              <g key={player.track_id}>
                                <rect x={x} y={y} width={w} height={h} fill="none" stroke="rgb(34,197,94)" strokeWidth="0.004" vectorEffect="non-scaling-stroke" />
                                <rect x={x} y={Math.max(0, y - 0.035)} width="0.085" height="0.035" fill="rgba(15,23,42,0.88)" />
                                <text x={x + 0.004} y={Math.max(0.026, y - 0.009)} fill="white" fontSize="0.026" fontWeight="800">ID {player.track_id}</text>
                              </g>
                            );
                          })}

                          {tracking && currentTrackingFrame?.balls?.map((ball, index) => (
                            <g key={`ball-${currentTrackingFrame.frame}-${index}`}>
                              <circle cx={ball.center.x / tracking.width} cy={ball.center.y / tracking.height} r="0.012" fill="rgba(250,204,21,0.35)" stroke="rgb(250,204,21)" strokeWidth="0.004" vectorEffect="non-scaling-stroke" />
                              <text x={ball.center.x / tracking.width + 0.014} y={ball.center.y / tracking.height} fill="rgb(254,240,138)" fontSize="0.022" fontWeight="800">BALL</text>
                            </g>
                          ))}

                          {ballLabelBox && (
                            <g>
                              <rect x={ballLabelBox.x} y={ballLabelBox.y} width={ballLabelBox.width} height={ballLabelBox.height} fill="rgba(250,204,21,0.12)" stroke="rgb(250,204,21)" strokeWidth="0.005" vectorEffect="non-scaling-stroke" />
                              <text x={ballLabelBox.x} y={Math.max(0.025, ballLabelBox.y - 0.012)} fill="rgb(254,240,138)" fontSize="0.026" fontWeight="800">VOLLEYBALL LABEL</text>
                            </g>
                          )}

                          {courtPoints.map((point, index) => (
                            <g key={`${index}-${point.x}-${point.y}`}>
                              <circle cx={point.x} cy={point.y} r="0.018" fill="rgb(250,204,21)" stroke="white" strokeWidth="0.004" vectorEffect="non-scaling-stroke" />
                              <text x={point.x} y={point.y - 0.028} textAnchor="middle" fill="white" fontSize="0.035" fontWeight="800">{index + 1}</text>
                            </g>
                          ))}
                        </svg>
                      </div>
                    )}
                  </div>

                  {courtCalibrationMode && (
                    <div className="mt-3 rounded-xl bg-amber-950/50 p-4 ring-1 ring-amber-300/30">
                      <div className="font-bold text-amber-100">Court calibration · {courtPoints.length}/4</div>
                      <p className="mt-1 text-sm text-amber-100/75">Click the four outside court corners in order around the court. If one is wrong, press Reset and click the four points again.</p>
                      <div className="mt-3 flex gap-2">
                        <button onClick={resetCourtCalibration} className="rounded-lg bg-white/15 px-3 py-2 text-sm font-bold">Reset</button>
                        <button onClick={() => { setCourtCalibrationMode(false); setCourtPoints(selected.court_calibration?.points || []); setCourtConfirmed(Boolean(selected.court_calibration?.confirmed)); }} className="rounded-lg bg-white/15 px-3 py-2 text-sm font-bold">Cancel</button>
                        <button disabled={courtPoints.length !== 4} onClick={confirmCourtCalibration} className="rounded-lg bg-cyan-300 px-3 py-2 text-sm font-bold text-slate-950 disabled:opacity-40">Confirm court</button>
                      </div>
                    </div>
                  )}

                  {ballLabelMode && (
                    <div className="mt-3 rounded-xl bg-yellow-950/50 p-4 ring-1 ring-yellow-300/30">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="font-bold text-yellow-100">Ball training mode · {ballTrainingCount} saved samples</div>
                          <p className="mt-1 text-sm text-yellow-100/75">Labeling stays on while you move through the video. Play or scrub to the next useful moment, pause, draw a tight ball box, save, and continue.</p>
                        </div>
                        <a href={BALL_LABELS_ENDPOINT} target="_blank" className="rounded-lg bg-white/10 px-3 py-2 text-xs font-bold">Dataset index</a>
                      </div>

                      <div className="mt-3 rounded-xl bg-black/20 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <button type="button" onClick={() => stepBallLabelFrame(-1)} className="rounded-lg bg-white/15 px-3 py-2 text-sm font-bold">← 1 frame</button>
                          <button type="button" onClick={toggleBallLabelPlayback} className="min-w-24 rounded-lg bg-cyan-300 px-4 py-2 text-sm font-bold text-slate-950">{videoPlaying ? "Pause" : "Play"}</button>
                          <button type="button" onClick={() => stepBallLabelFrame(1)} className="rounded-lg bg-white/15 px-3 py-2 text-sm font-bold">1 frame →</button>
                          <span className="ml-auto text-sm font-bold text-yellow-100">{formatTime(currentTime)} / {formatTime(videoDuration)}</span>
                        </div>
                        <input
                          aria-label="Ball labeling video position"
                          type="range"
                          min={0}
                          max={Math.max(videoDuration, 0.001)}
                          step={0.001}
                          value={Math.min(currentTime, Math.max(videoDuration, 0.001))}
                          onChange={(event) => seekBallLabelVideo(Number(event.currentTarget.value))}
                          className="mt-3 w-full accent-yellow-300"
                        />
                        <div className="mt-2 text-xs text-yellow-100/65">Shortcuts: Space = play/pause · ←/→ = one frame. Starting a box automatically pauses the video.</div>
                      </div>

                      <p className="mt-3 rounded-lg bg-black/20 p-2 text-sm text-yellow-100">{ballLabelStatus}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button onClick={() => setBallLabelBox(null)} className="rounded-lg bg-white/15 px-3 py-2 text-sm font-bold">Clear box</button>
                        <button disabled={!ballLabelBox || ballLabelSaving} onClick={saveBallLabel} className="rounded-lg bg-yellow-300 px-3 py-2 text-sm font-bold text-slate-950 disabled:opacity-40">{ballLabelSaving ? "Saving..." : "Save volleyball label"}</button>
                        <button onClick={() => { setBallLabelMode(false); setBallLabelBox(null); ballDragStartRef.current = null; }} className="rounded-lg bg-white/15 px-3 py-2 text-sm font-bold">Done labeling</button>
                      </div>
                    </div>
                  )}

                  <div className="mt-3 rounded-xl bg-purple-950/40 p-3 text-sm text-purple-100 ring-1 ring-purple-300/20">
                    <div className="flex justify-between gap-3"><strong>AI worker</strong><span>{analyzing ? `${analyzeProgress}%` : ""}</span></div>
                    <p className="mt-1">{analyzeStatus}</p>
                    {analyzing && <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-purple-300 transition-all" style={{ width: `${analyzeProgress}%` }} /></div>}
                  </div>

                  <div className="mt-4 rounded-xl bg-slate-950/50 p-4 ring-1 ring-white/10">
                    <div className="text-sm uppercase tracking-widest text-cyan-200">Tracking overlay · {formatTime(currentTime)}</div>
                    <div className="mt-2 text-2xl font-black">{currentTrackingFrame ? `${currentTrackingFrame.players.length} tracked players visible` : "No tracking overlay loaded"}</div>
                    <div className="text-white/70">{currentTrackingFrame ? currentTrackingFrame.players.map((player) => `ID ${player.track_id}`).join(" · ") || "No accepted player detections in this frame" : "Run AI to load real player boxes and IDs."}</div>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-5">
                  <Stat label="Stable player IDs" value={String(summary?.unique_track_count ?? 0)} />
                  <Stat label="Ball detections" value={String(tracking?.ball_detections ?? 0)} />
                  <Stat label="Ball training samples" value={String(ballTrainingCount)} />
                  <Stat label="Off-court removed" value={String(summary?.detections_removed_outside_court ?? 0)} />
                  <Stat label="Frames tracked" value={String(summary?.frame_count ?? 0)} />
                </div>

                <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10">
                  <h2 className="text-xl font-bold">Add a missed action</h2>
                  <p className="mt-1 text-sm text-white/60">If AI misses a serve, pass, set, attack, dig, or block, add it here. Manual labels are saved as reviewed training examples.</p>
                  <div className="mt-3 grid gap-2 md:grid-cols-4">
                    <input className="rounded bg-white/10 p-2" value={tagPlayer} onChange={(e) => setTagPlayer(e.target.value)} placeholder="#12" />
                    <input className="rounded bg-white/10 p-2" value={tagAction} onChange={(e) => setTagAction(e.target.value)} placeholder="serve / receive / set / attack / dig / block" />
                    <input className="rounded bg-white/10 p-2" value={tagOutcome} onChange={(e) => setTagOutcome(e.target.value)} placeholder="kill / in-system / error" />
                    <button onClick={addManualTouch} className="rounded-xl bg-white/15 px-4 py-2 font-bold hover:bg-white/25">Add at current time</button>
                  </div>
                </div>

                <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10">
                  <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-bold">AI action review</h2><p className="mt-1 text-sm text-white/60">AI suggestions are experimental. Correct them here; every saved review becomes training data. In local mode it stays on this Mac and immediately helps the review-memory action learner on the next AI run.</p></div><a className="rounded-lg bg-white/10 px-3 py-2 text-xs font-bold hover:bg-white/20" href={TRAINING_FEEDBACK_ENDPOINT} target="_blank">Training feedback index</a></div>
                  <p className="mt-3 rounded-lg bg-cyan-950/40 p-2 text-sm text-cyan-100">{feedbackStatus}</p>
                  <div className="mt-4 max-h-[420px] overflow-auto rounded-xl border border-white/10">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-slate-900 text-left"><tr><th className="p-3">Time</th><th>Action</th><th>Player</th><th>Outcome</th><th>AI conf.</th><th>Review</th></tr></thead>
                      <tbody>
                        {allTouches.map((touch) => (
                          <TouchReviewRow
                            key={touch.id}
                            touch={touch}
                            onJump={() => { if (videoRef.current) videoRef.current.currentTime = touch.start_time; }}
                            onSave={(changes) => reviewTouch(touch, changes)}
                          />
                        ))}
                        {!allTouches.length && <tr><td className="p-4 text-white/50" colSpan={6}>No action candidates yet. If the generic YOLO model misses the volleyball, add the actions manually; those labels are exactly what we need to train a volleyball-specific model.</td></tr>}
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

function TouchReviewRow({ touch, onJump, onSave }: { touch: Touch; onJump: () => void; onSave: (changes: Partial<Touch>) => Promise<void> }) {
  const [action, setAction] = useState(touch.action);
  const [player, setPlayer] = useState(touch.player);
  const [outcome, setOutcome] = useState(touch.outcome);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setAction(touch.action); setPlayer(touch.player); setOutcome(touch.outcome); }, [touch.action, touch.player, touch.outcome]);

  async function save() {
    setSaving(true);
    try { await onSave({ action, player, outcome }); } finally { setSaving(false); }
  }

  return (
    <tr className="border-t border-white/10 hover:bg-white/5">
      <td className="p-3 text-cyan-200"><button onClick={onJump} className="font-bold hover:underline">{formatTime(touch.start_time)}</button></td>
      <td><select value={action} onChange={(e) => setAction(e.target.value)} className="rounded bg-slate-800 p-2"><option>serve</option><option>pass</option><option>set</option><option>attack</option><option>dig</option><option>block</option><option>touch</option></select></td>
      <td><input value={player} onChange={(e) => setPlayer(e.target.value)} className="w-24 rounded bg-slate-800 p-2" /></td>
      <td><input value={outcome} onChange={(e) => setOutcome(e.target.value)} className="w-32 rounded bg-slate-800 p-2" /></td>
      <td>{Math.round(touch.confidence * 100)}%</td>
      <td><button onClick={save} disabled={saving} className={`rounded px-3 py-2 text-xs font-bold ${touch.reviewed ? "bg-green-500/70" : "bg-amber-300 text-slate-950"}`}>{saving ? "Saving..." : touch.reviewed ? "Reviewed" : "Approve / save"}</button></td>
    </tr>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl bg-white/10 p-5 ring-1 ring-white/10"><div className="text-3xl font-black">{value}</div><div className="text-white/70">{label}</div></div>;
}
