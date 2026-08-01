import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const SUPABASE_URL = 'https://yyqxesnrlgzifydkzkpd.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl5cXhlc25ybGd6aWZ5ZGt6a3BkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzNDE1MjUsImV4cCI6MjEwMDkxNzUyNX0.MTRwQ3sfyuhO37mEma4j985kWKdRvnsaAtCCGVd-NoE';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
