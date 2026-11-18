// config.js — paste your own Supabase project values here.
// Both of these are PUBLIC values (Supabase's "anon" key is designed
// to sit in client-side code like this). Never put a service_role
// key here or anywhere in this static site.

const SUPABASE_URL = 'https://idfsirnnxfihwtzzbljh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlkZnNpcm5ueGZpaHd0enpibGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ4MzU4ODYsImV4cCI6MjExMDQxMTg4Nn0.UUARlLSLthGEduusTlaAc4rnQI64uF6p-2rP0koIBCE';

// How long an auto-delete message copy remains available.
const AUTO_DELETE_MINUTES = 10;

// Choices for the per-chat auto-delete duration (minutes).
const AUTO_DELETE_OPTIONS = [10, 60, 1440];

// How long (in hours) a status/story stays visible.
const STATUS_LIFETIME_HOURS = 24;

// Apply the saved theme BEFORE first paint (this file loads before
// app.js) so dark mode never flashes light. 'system' follows the OS.
try {
  const saved = localStorage.getItem('soulnix-theme') || 'light';
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved === 'system' ? (prefersDark ? 'dark' : 'light') : saved;
  document.documentElement.dataset.theme = theme;
} catch (_) { /* localStorage unavailable — light theme is the default */ }
