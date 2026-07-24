/** Row shapes returned by the worker /family API. */

export interface FamilyTask {
  id: string;
  title: string;
  notes: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  due_at: string | null;
  priority: number;
  status: 'open' | 'done';
  created_by: string;
  created_by_name: string | null;
  completed_at: string | null;
  completed_by: string | null;
  category: string | null;
  source: string | null;
  created_at: string;
}

export interface FamilyList {
  id: string;
  name: string;
  kind: 'shopping' | 'todo' | 'custom';
  archived: boolean;
  created_at: string;
}

export interface FamilyListItem {
  id: string;
  list_id: string;
  text: string;
  note: string | null;
  done: boolean;
  done_by: string | null;
  done_by_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  source: string | null;
  created_at: string;
}

export interface ItemComment {
  id: string;
  item_id: string;
  author_id: string;
  author_name: string | null;
  body: string;
  created_at: string;
}

export interface FamilyEvent {
  id: string;
  title: string;
  location: string | null;
  notes: string | null;
  start_at: string;
  end_at: string | null;
  all_day: boolean;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface FamilyHabit {
  id: string;
  user_id: string;
  owner_name: string | null;
  name: string;
  description: string | null;
  target_per_week: number;
  shared: boolean;
  week_count: number;
  done_today: boolean;
}

export interface FamilyProposal {
  id: string;
  kind: 'task' | 'event';
  payload: {
    title?: string;
    notes?: string;
    due_date?: string;
    date?: string;
    time?: string;
    duration_min?: number;
    location?: string;
  };
  subject: string | null;
  sender_email: string | null;
  status: 'pending' | 'accepted' | 'dismissed';
  created_at: string;
}

export interface FeedItem {
  decision_id: string;
  decision: { classification: string; urgency_score?: number; [k: string]: unknown };
  reasoning: string | null;
  feedback: 'correct' | 'wrong' | 'adjusted' | null;
  feedback_note: string | null;
  created_at: string;
  subject: string | null;
  sender_email: string | null;
  sender_name: string | null;
  received_at: string;
  classification: string;
  account_label: string | null;
}
