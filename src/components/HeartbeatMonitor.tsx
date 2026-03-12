import React, { useEffect, useRef, useState } from 'react';
import { Activity, Heart, AlertCircle, CheckCircle2, Zap } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface HeartbeatMonitorProps {
  onDataUpdate: (bpm: number, confidence: number, stressScore: number) => void;
  onStatusChange: (connected: boolean, status: string) => void;
}

const SAMPLE_INTERVAL_MS = 10;
const BUFFER_SIZE = 500;
const BASELINE_N = 500;
const SMOOTH_N = 15;
const AMPLITUDE_THRESHOLD = 80;
const MAX_PEAKS_STORED = 12;

export const HeartbeatMonitor: React.FC<HeartbeatMonitorProps> = ({ onDataUpdate, onStatusChange }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const portRef = useRef<any>(null);
  const readerRef = useRef<any>(null);
  
  // Signal Processing State (Refs for performance to avoid re-renders at 100Hz)
  const rawBuffer = useRef<number[]>(new Array(BUFFER_SIZE).fill(2047.5));
  const smoothedBuffer = useRef<number[]>(new Array(BUFFER_SIZE).fill(0));
  const baselineWindow = useRef<number[]>(new Array(BASELINE_N).fill(2047.5));
  const baselineSum = useRef<number>(BASELINE_N * 2047.5);
  const smoothWindow = useRef<number[]>([]);
  const prevSmoothed = useRef<number>(0);
  const prevSlope = useRef<number>(0);
  const sampleCount = useRef<number>(0);
  const peakSampleCounts = useRef<number[]>([]);

  const connectSerial = async () => {
    try {
      const port = await (navigator as any).serial.requestPort();
      await port.open({ baudRate: 115200 });
      portRef.current = port;

      const decoder = new TextDecoderStream();
      port.readable.pipeTo(decoder.writable);
      readerRef.current = decoder.readable.getReader();

      onStatusChange(true, "Connected");
      readLoop();
    } catch (err) {
      onStatusChange(false, "Connection failed. Please try again.");
      console.error(err);
    }
  };

  const readLoop = async () => {
    let partial = "";
    while (true) {
      try {
        const { value, done } = await readerRef.current.read();
        if (done) {
          onStatusChange(false, "Disconnected");
          break;
        }
        partial += value;
        const lines = partial.split("\n");
        partial = lines.pop() || "";

        for (const line of lines) {
          const parts = line.trim().split(",");
          if (parts.length === 2) {
            const val = parseInt(parts[1]);
            if (!isNaN(val)) processSample(val);
          }
        }
      } catch (err) {
        onStatusChange(false, "Serial read error");
        break;
      }
    }
  };

  const processSample = (raw: number) => {
    sampleCount.current++;
    
    // Raw Buffer
    rawBuffer.current.push(raw);
    rawBuffer.current.shift();

    // Step 1: Baseline Subtraction
    baselineSum.current -= baselineWindow.current.shift()!;
    baselineWindow.current.push(raw);
    baselineSum.current += raw;
    const dc = raw - baselineSum.current / BASELINE_N;

    // Step 2: Smoothing
    smoothWindow.current.push(dc);
    if (smoothWindow.current.length > SMOOTH_N) smoothWindow.current.shift();
    const sm = smoothWindow.current.reduce((a, b) => a + b, 0) / smoothWindow.current.length;
    
    smoothedBuffer.current.push(sm);
    smoothedBuffer.current.shift();

    // Step 3: Differentiation
    const slope = sm - prevSmoothed.current;
    prevSmoothed.current = sm;

    // Step 4: Peak Detection
    const isPeak = prevSlope.current > 0 && slope <= 0 && sm > AMPLITUDE_THRESHOLD;
    if (isPeak) {
      peakSampleCounts.current.push(sampleCount.current);
      if (peakSampleCounts.current.length > MAX_PEAKS_STORED) peakSampleCounts.current.shift();
      
      // Calculate Stats
      const stats = calculateStats();
      onDataUpdate(stats.bpm, stats.confidence, stats.stressScore);
    }
    prevSlope.current = slope;
  };

  const calculateStats = () => {
    if (peakSampleCounts.current.length < 3) return { bpm: 0, confidence: 0, stressScore: 0 };

    const intervals = [];
    for (let i = 1; i < peakSampleCounts.current.length; i++) {
      intervals.push((peakSampleCounts.current[i] - peakSampleCounts.current[i - 1]) * SAMPLE_INTERVAL_MS);
    }

    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const bpm = 60000 / mean;
    
    const variance = intervals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / intervals.length;
    const stdDev = Math.sqrt(variance);
    const cv = stdDev / mean;
    const confidence = Math.max(0, 1 - cv / 0.3);

    // Stress Score Calculation: Higher BPM + Lower Confidence (HRV-ish) = Higher Stress
    // Normal resting BPM is 60-100. Let's say > 90 starts increasing stress score.
    const bpmFactor = Math.min(1, Math.max(0, (bpm - 60) / 60)); // 0 at 60, 1 at 120
    const confidenceFactor = 1 - confidence; // 0 at full confidence, 1 at none
    const stressScore = (bpmFactor * 0.6 + confidenceFactor * 0.4) * 100;

    return { bpm, confidence, stressScore };
  };

  // Animation Loop for Canvas
  useEffect(() => {
    let animationFrameId: number;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      const w = canvas.width;
      const h = canvas.height;
      const halfH = h / 2;

      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, w, h);

      // Draw Grid
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineWidth = 1;
      for (let i = 0; i < w; i += 50) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, h); ctx.stroke();
      }
      for (let i = 0; i < h; i += 50) {
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(w, i); ctx.stroke();
      }

      // Draw Raw Waveform (Top)
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < rawBuffer.current.length; i++) {
        const x = (i / (BUFFER_SIZE - 1)) * w;
        const y = ((rawBuffer.current[i] - 0) / (4095 - 0)) * (halfH - 20) + 10;
        if (i === 0) ctx.moveTo(x, halfH - y);
        else ctx.lineTo(x, halfH - y);
      }
      ctx.stroke();

      // Draw Smoothed Waveform (Bottom)
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < smoothedBuffer.current.length; i++) {
        const x = (i / (BUFFER_SIZE - 1)) * w;
        const y = ((smoothedBuffer.current[i] - (-500)) / (500 - (-500))) * (h - halfH - 20) + halfH + 10;
        if (i === 0) ctx.moveTo(x, h - (y - halfH) - halfH);
        else ctx.lineTo(x, h - (y - halfH) - halfH);
      }
      ctx.stroke();

      // Draw Peaks
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      peakSampleCounts.current.forEach(ps => {
        const samplesAgo = sampleCount.current - ps;
        if (samplesAgo >= 0 && samplesAgo < BUFFER_SIZE) {
          const x = ((BUFFER_SIZE - samplesAgo) / (BUFFER_SIZE - 1)) * w;
          ctx.beginPath();
          ctx.moveTo(x, halfH + 10);
          ctx.lineTo(x, h - 10);
          ctx.stroke();
        }
      });

      // Divider
      ctx.strokeStyle = '#333';
      ctx.beginPath(); ctx.moveTo(0, halfH); ctx.lineTo(w, halfH); ctx.stroke();

      animationFrameId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrameId);
  }, []);

  return (
    <div className="relative w-full bg-black rounded-2xl overflow-hidden border border-white/10 shadow-2xl">
      <canvas 
        ref={canvasRef} 
        width={800} 
        height={400} 
        className="w-full h-auto block"
      />
      <div className="absolute top-4 left-4 flex gap-4">
        <button 
          onClick={connectSerial}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors flex items-center gap-2 shadow-lg"
        >
          <Zap size={16} />
          Connect ESP32
        </button>
      </div>
    </div>
  );
};
