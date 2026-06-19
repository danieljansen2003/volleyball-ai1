'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

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

type Match = {
  id: number;
  title: string;
  opponent: string;
  status: string;
  duration_seconds: number;
  created_at: string;
  rallies: Rally[];
  video_url: string;
  filename: string;
};

type RosterPlayer = { number: string; name: string; build: string; role: string };
type PlaybackMode = 'normal' | 'rally-only' | 'top5';

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function playerText(p?: RosterPlayer) {
  if (!p) return 'Unknown';
  return `#${p.number || '?'} ${p.name || 'Player'}`;
}

function rolePick(roster: RosterPlayer[], role: string, fallbackIndex: number) {
  if (!roster.length) return undefined;
  const hit = roster.find(p => p.role.toLowerCase().includes(role.toLowerCase()) || p.build.toLowerCase().includes(role.toLowerCase()));
  return hit || roster[fallbackIndex % roster.length];
}

function makeRallies(duration: number, matchId: number, roster: RosterPlayer[]) {
  const rallies: Rally[] = [];
  const phases = ['Serve receive', 'Free ball transition', 'Out-of-system receive', 'Defensive transition', 'Sideout receive'];
  const results = ['kill', 'kept alive', 'error', 'tip covered', 'block touch', 'point won'];

  let t = 4;
  let i = 0;
  while (t < duration - 5) {
    // Less strict detector: assumes most rallies are 9-20 sec and gaps are dead time.
    const rallyLength = Math.min(9 + (i % 5) * 2.5, Math.max(5, duration - t));
    const receive = rolePick(roster, 'pass', i) || rolePick(roster, 'defensive', i) || roster[i % Math.max(1, roster.length)];
    const setter = rolePick(roster, 'setter', i + 1) || roster[(i + 1) % Math.max(1, roster.length)];
    const attacker = rolePick(roster, 'hitter', i + 2) || rolePick(roster, 'outside', i + 2) || roster[(i + 2) % Math.max(1, roster.length)];
    const cover = rolePick(roster, 'middle', i + 3) || roster[(i + 3) % Math.max(1, roster.length)];

    const base = Math.round(t * 10) / 10;
    const touchSpecs = [
      { off: 0.0, len: 1.4, action: i % 4 === 0 ? 'Serve' : 'Serve receive / pass', player: i % 4 === 0 ? attacker : receive, outcome: i % 4 === 0 ? 'serve in' : 'in-system pass' },
      { off: Math.min(2.4, rallyLength * 0.25), len: 1.2, action: 'Set', player: setter, outcome: 'set to pin/middle' },
      { off: Math.min(4.6, rallyLength * 0.48), len: 1.5, action: 'Attack', player: attacker, outcome: results[i % results.length] },
      { off: Math.min(6.8, rallyLength * 0.68), len: 1.4, action: i % 3 === 0 ? 'Block touch' : 'Dig / cover', player: cover, outcome: i % 3 === 0 ? 'block touch' : 'kept alive' },
    ];

    const touches = touchSpecs
      .filter(spec => spec.off < rallyLength - 0.5)
      .map((spec, j) => ({
        id: matchId + i * 100 + j,
        rally_id: matchId + i,
        start_time: Math.round((base + spec.off) * 10) / 10,
        end_time: Math.round(Math.min(base + rallyLength, base + spec.off + spec.len) * 10) / 10,
        action: spec.action,
        player: playerText(spec.player),
        outcome: spec.outcome,
        notes: `Browser estimate based on rally timing + roster role/body-build hints. Upgrade path: YOLO players + jersey OCR + pose/ball tracking.`,
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
  const [matches, setMatches] = useState<Match[]>([]);
  const [selected, setSelected] = useState<Match | null>(null);
  const [title, setTitle] = useState('Varsity Match');
  const [opponent, setOpponent] = useState('Opponent');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [currentTouchId, setCurrentTouchId] = useState<number | null>(null);
  const [currentRallyId, setCurrentRallyId] = useState<number | null>(null);
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>('normal');
  const [activePlaylist, setActivePlaylist] = useState<Rally[]>([]);
  const [playlistIndex, setPlaylistIndex] = useState(0);
  const [tagPlayer, setTagPlayer] = useState('#12');
  const [tagAction, setTagAction] = useState('attack');
  const [tagOutcome, setTagOutcome] = useState('kill');
  const [roster, setRoster] = useState<RosterPlayer[]>([
    { number: '8', name: 'Player 8', build: 'tall outside/right-side build', role: 'outside hitter' },
    { number: '12', name: 'Player 12', build: 'middle/tall blocker build', role: 'middle blocker' },
    { number: '1', name: 'Player 1', build: 'setter/defensive build', role: 'setter' },
    { number: '2', name: 'Player 2', build: 'left-back passer build', role: 'passer/libero' },
    { number: '3', name: 'Player 3', build: 'right-back defender build', role: 'defensive specialist' },
    { number: '4', name: 'Player 4', build: 'outside hitter build', role: 'hitter' },
  ]);

  useEffect(() => {
    const savedRoster = window.localStorage.getItem('volleyvision-roster-v2');
    if (savedRoster) setRoster(JSON.parse(savedRoster));
  }, []);

  useEffect(() => {
    window.localStorage.setItem('volleyvision-roster-v2', JSON.stringify(roster));
  }, [roster]);

  const sortedRallies = useMemo(() => [...(selected?.rallies || [])].sort((a, b) => a.start_time - b.start_time), [selected]);
  const allTouches = useMemo(() => sortedRallies.flatMap(r => r.touches.map(t => ({ ...t, rally: r }))).sort((a, b) => a.start_time - b.start_time), [sortedRallies]);
  const top5Rallies = useMemo(() => [...sortedRallies].sort((a, b) => b.confidence - a.confidence).slice(0, 5), [sortedRallies]);
  const activeTouch = useMemo(() => allTouches.find(t => currentTime >= t.start_time && currentTime < t.end_time) || allTouches.filter(t => t.start_time <= currentTime).at(-1) || null, [allTouches, currentTime]);
  const activeRally = useMemo(() => sortedRallies.find(r => currentTime >= r.start_time && currentTime < r.end_time) || sortedRallies.filter(r => r.start_time <= currentTime).at(-1) || null, [sortedRallies, currentTime]);

  useEffect(() => {
    setCurrentTouchId(activeTouch?.id || null);
    setCurrentRallyId(activeRally?.id || null);
  }, [activeTouch, activeRally]);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentTouchId]);

  function jumpToTime(seconds: number, autoplay = true) {
    setPlaybackMode('normal');
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(0, seconds);
      setCurrentTime(seconds);
      if (autoplay) videoRef.current.play();
    }
  }

  function upload() {
    if (!file) return alert('Choose a video first.');
    setLoading(true);
    setUploadProgress(0);
    setPlaybackMode('normal');

    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.src = url;

    const timer = window.setInterval(() => setUploadProgress(p => Math.min(95, p + 5)), 120);

    probe.onloadedmetadata = () => {
      window.clearInterval(timer);
      const matchId = Date.now();
      const duration = Number.isFinite(probe.duration) ? probe.duration : 0;
      const rallies = makeRallies(duration, matchId, roster);
      const match: Match = { id: matchId, title, opponent, status: 'processed in browser', duration_seconds: duration, created_at: new Date().toISOString(), rallies, video_url: url, filename: file.name };
      setMatches(prev => [match, ...prev]);
      setSelected(match);
      setUploadProgress(100);
      setLoading(false);
    };

    probe.onerror = () => {
      window.clearInterval(timer);
      setLoading(false);
      setUploadProgress(0);
      alert('Could not read that video file. Try an MP4 file.');
    };
  }

  function deleteMatch(match: Match) {
    if (!confirm(`Remove "${match.title}"?`)) return;
    URL.revokeObjectURL(match.video_url);
    const remaining = matches.filter(m => m.id !== match.id);
    setMatches(remaining);
    if (selected?.id === match.id) setSelected(remaining[0] || null);
    setPlaybackMode('normal');
  }

  function addManualTouch() {
    if (!selected) return;
    const start = videoRef.current?.currentTime || 0;
    const rosterHit = roster.find(p => `#${p.number}` === tagPlayer || p.number === tagPlayer.replace('#', ''));
    const player = rosterHit ? playerText(rosterHit) : tagPlayer;
    const rally = sortedRallies.find(r => start >= r.start_time && start <= r.end_time);
    const touch: Touch = { id: Date.now(), rally_id: rally?.id || Date.now() + 1, start_time: start, end_time: Math.min(selected.duration_seconds, start + 2), action: tagAction, player, outcome: tagOutcome, notes: rosterHit ? `Manual tag. Body-build note: ${rosterHit.build}` : 'Manual tag', confidence: 1 };

    let updatedRallies: Rally[];
    if (rally) {
      updatedRallies = selected.rallies.map(r => r.id === rally.id ? { ...r, touches: [...r.touches, touch].sort((a,b) => a.start_time - b.start_time) } : r);
    } else {
      const newRally: Rally = { id: touch.rally_id, match_id: selected.id, start_time: start, end_time: Math.min(selected.duration_seconds, start + 10), phase: 'Manual rally', result: tagOutcome, confidence: 1, touches: [touch] };
      updatedRallies = [...selected.rallies, newRally].sort((a,b) => a.start_time - b.start_time);
    }
    const updated = { ...selected, rallies: updatedRallies };
    setSelected(updated);
    setMatches(prev => prev.map(m => m.id === selected.id ? updated : m));
  }

  function playPlaylist(rallies: Rally[], mode: PlaybackMode) {
    if (!selected || !rallies.length || !videoRef.current) return alert('No rallies yet. Upload a video or add a manual tag.');
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
      if (playbackMode === 'normal' || !activePlaylist.length) return;
      const current = activePlaylist[playlistIndex];
      if (!current) return;
      if (video.currentTime >= current.end_time) {
        const nextIndex = playlistIndex + 1;
        if (nextIndex >= activePlaylist.length) {
          video.pause();
          setPlaybackMode('normal');
          return;
        }
        const next = activePlaylist[nextIndex];
        setPlaylistIndex(nextIndex);
        setCurrentRallyId(next.id);
        video.currentTime = next.start_time;
        video.play();
      }
    };
    video.addEventListener('timeupdate', onTimeUpdate);
    return () => video.removeEventListener('timeupdate', onTimeUpdate);
  }, [playbackMode, activePlaylist, playlistIndex]);

  const actionStats = allTouches.reduce<Record<string, number>>((acc, e) => { acc[e.action] = (acc[e.action] || 0) + 1; return acc; }, {});
  const playerStats = allTouches.reduce<Record<string, number>>((acc, e) => { acc[e.player] = (acc[e.player] || 0) + 1; return acc; }, {});
  const rallySeconds = sortedRallies.reduce((sum, e) => sum + Math.max(0, e.end_time - e.start_time), 0);
  const deadTimeRemoved = Math.max(0, (selected?.duration_seconds || 0) - rallySeconds);

  return (
    <main className="min-h-screen p-6">
      <section className="mx-auto max-w-7xl">
        <div className="mb-8 rounded-3xl bg-gradient-to-r from-blue-600 to-cyan-500 p-8 shadow-2xl">
          <p className="text-sm uppercase tracking-widest text-blue-100">Volleyball AI Video Analysis</p>
          <h1 className="mt-2 text-5xl font-black">VolleyVision AI</h1>
          <p className="mt-3 max-w-3xl text-blue-50">Vercel-ready browser mode with rally sequences, player-role estimates, live event tracking, smart playback, and manual correction tools.</p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
          <aside className="space-y-6">
            <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10">
              <h2 className="text-xl font-bold">Upload video</h2>
              <input className="mt-4 w-full rounded bg-white/10 p-2" value={title} onChange={e => setTitle(e.target.value)} />
              <input className="mt-3 w-full rounded bg-white/10 p-2" value={opponent} onChange={e => setOpponent(e.target.value)} />
              <input className="mt-3 w-full" type="file" accept="video/*" onChange={e => setFile(e.target.files?.[0] || null)} />
              {(loading || uploadProgress > 0) && <div className="mt-4"><div className="mb-1 flex justify-between text-xs text-white/70"><span>Upload progress</span><span>{uploadProgress}%</span></div><div className="h-3 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-cyan-400 transition-all" style={{ width: `${uploadProgress}%` }} /></div></div>}
              <button onClick={upload} disabled={loading} className="mt-4 w-full rounded-xl bg-cyan-400 px-4 py-3 font-bold text-slate-950 hover:bg-cyan-300 disabled:opacity-60">{loading ? 'Processing...' : 'Upload + Process'}</button>
              <p className="mt-3 text-xs text-white/50">This Vercel version estimates events in-browser. True AI player/action recognition needs a deployed CV backend.</p>
            </div>

            <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10">
              <h2 className="text-xl font-bold">Roster / role hints</h2>
              <p className="mt-1 text-sm text-white/60">Add each player plus role. The estimator uses this to assign pass/set/attack/block touches inside each rally.</p>
              <div className="mt-3 space-y-2">
                {roster.map((p, i) => <div key={i} className="grid grid-cols-[56px_1fr] gap-2 rounded-xl bg-white/5 p-2">
                  <input className="rounded bg-white/10 p-2" value={p.number} onChange={e => setRoster(r => r.map((x, idx) => idx === i ? { ...x, number: e.target.value } : x))} placeholder="#" />
                  <input className="rounded bg-white/10 p-2" value={p.name} onChange={e => setRoster(r => r.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))} placeholder="Name" />
                  <input className="rounded bg-white/10 p-2 text-sm" value={p.role} onChange={e => setRoster(r => r.map((x, idx) => idx === i ? { ...x, role: e.target.value } : x))} placeholder="setter/libero/outside" />
                  <input className="rounded bg-white/10 p-2 text-sm" value={p.build} onChange={e => setRoster(r => r.map((x, idx) => idx === i ? { ...x, build: e.target.value } : x))} placeholder="body build" />
                </div>)}
              </div>
              <button onClick={() => setRoster([...roster, { number: '', name: '', build: '', role: '' }])} className="mt-3 w-full rounded-xl bg-white/15 px-4 py-2 font-bold hover:bg-white/25">Add player</button>
            </div>

            <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10">
              <h2 className="text-xl font-bold">Matches</h2>
              <div className="mt-4 space-y-2">
                {matches.map(m => <div key={m.id} className={`rounded-xl ${selected?.id === m.id ? 'bg-cyan-400 text-slate-950' : 'bg-white/10'}`}>
                  <button onClick={() => { setSelected(m); setPlaybackMode('normal'); }} className="w-full p-3 text-left hover:opacity-80"><div className="font-bold">{m.title}</div><div className="text-sm opacity-80">{m.status} · {m.rallies.length} rallies · {m.rallies.reduce((n, r) => n + r.touches.length, 0)} touches</div></button>
                  <button onClick={() => deleteMatch(m)} className="mb-2 ml-3 rounded-lg bg-red-500/80 px-3 py-1 text-xs font-bold text-white hover:bg-red-500">Remove video</button>
                </div>)}
              </div>
            </div>
          </aside>

          <section className="space-y-6">
            {selected ? <>
              <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10">
                <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-2xl font-black">{selected.title}</h2><p className="text-white/70">vs {selected.opponent} · {formatTime(selected.duration_seconds)} · {selected.status}</p></div><div className="flex flex-wrap gap-2"><button disabled={!top5Rallies.length} onClick={() => playPlaylist(top5Rallies, 'top5')} className="rounded-xl bg-cyan-400 px-4 py-2 font-bold text-slate-950 hover:bg-cyan-300 disabled:opacity-50">Preview top 5 rallies</button><button disabled={!sortedRallies.length} onClick={() => playPlaylist(sortedRallies, 'rally-only')} className="rounded-xl bg-green-400 px-4 py-2 font-bold text-slate-950 hover:bg-green-300 disabled:opacity-50">Play rally-only</button>{playbackMode !== 'normal' && <button onClick={() => setPlaybackMode('normal')} className="rounded-xl bg-white/15 px-4 py-2 font-bold hover:bg-white/25">Stop smart playback</button>}</div></div>
                <video ref={videoRef} className="mt-5 w-full rounded-xl bg-black" controls src={selected.video_url} />
                <div className="mt-4 rounded-xl bg-slate-950/50 p-4 ring-1 ring-white/10"><div className="text-sm uppercase tracking-widest text-cyan-200">Live tracker · {formatTime(currentTime)}</div><div className="mt-2 text-2xl font-black">{activeTouch ? `${activeTouch.action}: ${activeTouch.player}` : 'No active touch yet'}</div><div className="text-white/70">{activeRally ? `${activeRally.phase} → ${activeRally.result}` : 'Press play to follow the breakdown.'}</div></div>
              </div>

              <div className="grid gap-6 md:grid-cols-4"><div className="rounded-2xl bg-white/10 p-5 ring-1 ring-white/10"><div className="text-3xl font-black">{sortedRallies.length}</div><div className="text-white/70">Rallies</div></div><div className="rounded-2xl bg-white/10 p-5 ring-1 ring-white/10"><div className="text-3xl font-black">{allTouches.length}</div><div className="text-white/70">Touches/actions</div></div><div className="rounded-2xl bg-white/10 p-5 ring-1 ring-white/10"><div className="text-3xl font-black">{formatTime(rallySeconds)}</div><div className="text-white/70">Active play</div></div><div className="rounded-2xl bg-white/10 p-5 ring-1 ring-white/10"><div className="text-3xl font-black">{formatTime(deadTimeRemoved)}</div><div className="text-white/70">Dead time skipped</div></div></div>

              <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10"><h2 className="text-xl font-bold">Add touch at current video time</h2><div className="mt-3 grid gap-2 md:grid-cols-4"><input className="rounded bg-white/10 p-2" value={tagPlayer} onChange={e => setTagPlayer(e.target.value)} placeholder="#12" /><input className="rounded bg-white/10 p-2" value={tagAction} onChange={e => setTagAction(e.target.value)} placeholder="attack" /><input className="rounded bg-white/10 p-2" value={tagOutcome} onChange={e => setTagOutcome(e.target.value)} placeholder="kill" /><button onClick={addManualTouch} className="rounded-xl bg-white/15 px-4 py-2 font-bold hover:bg-white/25">Add live-tracked touch</button></div></div>

              <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10"><h2 className="text-xl font-bold">Player/event summary</h2><div className="mt-3 grid gap-3 md:grid-cols-2"><div className="rounded-xl bg-white/5 p-3"><div className="font-bold">Actions by type</div>{Object.entries(actionStats).map(([k,v]) => <div key={k} className="mt-1 flex justify-between"><span className="capitalize">{k}</span><span>{v}</span></div>)}</div><div className="rounded-xl bg-white/5 p-3"><div className="font-bold">Estimated/manual players</div>{Object.entries(playerStats).slice(0, 12).map(([k,v]) => <div key={k} className="mt-1 flex justify-between"><span>{k}</span><span>{v}</span></div>)}</div></div></div>

              <div className="rounded-2xl bg-white/10 p-5 shadow-xl ring-1 ring-white/10"><h2 className="text-xl font-bold">Live rally breakdown</h2><p className="mt-1 text-sm text-white/60">This list follows the video. The current touch stays highlighted and scrolls into view. Click any row to jump there.</p><div className="mt-4 max-h-[560px] overflow-auto rounded-xl border border-white/10"><table className="w-full text-sm"><thead className="sticky top-0 bg-slate-900 text-left"><tr><th className="p-3">Time</th><th>Rally</th><th>Action sequence</th><th>Player</th><th>Outcome</th><th>Confidence</th></tr></thead><tbody>{sortedRallies.map(r => <>{r.touches.map((t, idx) => <tr ref={currentTouchId === t.id ? activeRowRef : null} key={t.id} onClick={() => jumpToTime(t.start_time)} title={t.notes} className={`cursor-pointer border-t border-white/10 hover:bg-cyan-400/20 ${currentTouchId === t.id ? 'bg-cyan-400/40' : currentRallyId === r.id ? 'bg-cyan-400/10' : ''}`}><td className="p-3 font-bold text-cyan-200">{formatTime(t.start_time)}</td><td>{idx === 0 ? <button onClick={(e) => { e.stopPropagation(); jumpToTime(r.start_time); }} className="rounded bg-white/10 px-2 py-1 text-xs font-bold hover:bg-white/20">{formatTime(r.start_time)}-{formatTime(r.end_time)}</button> : ''}</td><td><span className="capitalize font-bold">{t.action}</span>{idx === 0 && <span className="ml-2 text-white/50">({r.phase})</span>}</td><td>{t.player}</td><td>{t.outcome}</td><td>{Math.round(t.confidence * 100)}%</td></tr>)}</>)}</tbody></table></div></div>
            </> : <div className="rounded-2xl bg-white/10 p-10 text-center">Upload a video to get started.</div>}
          </section>
        </div>
      </section>
    </main>
  );
}
