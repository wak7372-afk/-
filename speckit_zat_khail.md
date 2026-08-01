# SpecKit — نظام "ذات خيل" لإدارة مركز تعليم القرآن الكريم وعلومه

**الغرض من هذا الملف:** مواصفة تنفيذية كاملة وغير غامضة، مصمَّمة ليتّبعها أي نموذج ذكاء اصطناعي (حتى النماذج الأرخص/الأبسط) خطوة بخطوة دون الحاجة لاتخاذ قرارات معمارية بنفسه. كل قرار تقني حُسم مسبقاً في وثيقة المتطلبات؛ هذا الملف يترجمها إلى مهام تنفيذ ملموسة.

---

## 0. مبادئ إلزامية للتنفيذ (Constitution)

1. **لا تُغيَّر القرارات المعمارية** الواردة في القسم 1 مهما بدت بديلاً "أفضل". نفّذ كما هو محدد بالضبط.
2. **نفّذ المراحل بالترتيب** (القسم 8) لأن كل مرحلة تعتمد على ما قبلها.
3. **كل مهمة يجب أن تُنجز كاملة وتُختبر يدوياً** قبل الانتقال للتي تليها.
4. **لا تستخدم أي إطار عمل JS** (React/Vue/Angular/Svelte...). فقط HTML + Vanilla JavaScript (ES Modules) + Tailwind CSS عبر CDN.
5. **كل صفحة HTML مستقلة** (Multi-Page App وليس Single Page App)، وتتشارك ملفات JS/CSS مشتركة عبر `/public/js/lib`.
6. **الأسماء (متغيرات، جداول، حقول) يجب أن تطابق حرفياً** ما ورد في القسم 3 (مخطط قاعدة البيانات) — لا ترجمة، لا اختصار، لا تغيير حروف كبيرة/صغيرة.
7. عند الشك في أي تفصيلة غير مذكورة، اتّخذ الخيار الأبسط الذي يحقق المتطلبات الوظيفية دون إضافة ميزات غير مطلوبة.
8. لا تُضِف نظام دفع، شهادات، أو تطبيق جوال أصلي — هذه خارج النطاق صراحة (انظر متطلبات القسم 7 في وثيقة المتطلبات الأصلية).

---

## 1. ملخص القرارات التقنية (Tech Stack — نهائي وغير قابل للتغيير)

| المكوّن | التقنية |
|---|---|
| الواجهة الأمامية | HTML5 + Vanilla JavaScript (ES Modules) |
| التنسيق | Tailwind CSS عبر CDN (`https://cdn.tailwindcss.com`) |
| الخطوط | Amiri (عناوين/نصوص قرآنية) + Cairo (نصوص عامة) — من Google Fonts |
| الخلفية وقاعدة البيانات | Supabase (PostgreSQL + Auth + Storage + Realtime + Edge Functions) |
| مكتبة قراءة Excel/CSV في المتصفح | SheetJS (xlsx) عبر CDN |
| الذكاء الاصطناعي | Gemini API — يُستدعى **حصراً** من داخل Supabase Edge Function |
| المنصة | PWA (manifest.json + service-worker.js) |
| اللغات | عربي (RTL، افتراضي) / إنجليزي (LTR) — تبديل عبر ملفات JSON محلية |
| الألوان | أخضر زمردي `#0A5C36` (أساسي) / ذهبي `#D4AF37` (ثانوي) |

---

## 2. هيكل المجلدات (Project Structure)

```
zat-khail/
├── public/
│   ├── index.html                 # صفحة تسجيل الدخول
│   ├── register.html              # تسجيل طالب/ولي أمر جديد
│   ├── pending-approval.html      # شاشة "بانتظار موافقة الإدارة"
│   ├── manifest.json
│   ├── service-worker.js
│   ├── assets/
│   │   ├── icons/                 # أيقونات PWA (192x192, 512x512)
│   │   └── images/
│   ├── css/
│   │   └── style.css              # تنسيقات إضافية فوق Tailwind (خطوط، ألوان مخصصة)
│   ├── locales/
│   │   ├── ar.json
│   │   └── en.json
│   ├── js/
│   │   ├── lib/
│   │   │   ├── supabase-client.js # تهيئة عميل Supabase
│   │   │   ├── auth.js            # دوال تسجيل الدخول/الخروج/التسجيل
│   │   │   ├── i18n.js            # تبديل اللغة
│   │   │   ├── notifications.js   # اشتراك Push + عرض الإشعارات داخل التطبيق
│   │   │   └── utils.js           # دوال مساعدة عامة
│   │   └── pages/
│   │       ├── admin-dashboard.js
│   │       ├── teacher-halaqat.js
│   │       ├── teacher-halaqa-detail.js
│   │       ├── teacher-classrooms.js
│   │       ├── teacher-classroom-detail.js
│   │       ├── teacher-lesson-editor.js
│   │       ├── teacher-quiz-editor.js
│   │       ├── teacher-grading.js
│   │       ├── teacher-attendance.js
│   │       ├── teacher-ai-assistant.js
│   │       ├── student-dashboard.js
│   │       ├── student-classroom.js
│   │       ├── student-quiz.js
│   │       ├── parent-dashboard.js
│   │       └── chat.js
│   ├── admin/
│   │   └── dashboard.html
│   ├── teacher/
│   │   ├── halaqat.html
│   │   ├── halaqa-detail.html
│   │   ├── classrooms.html
│   │   ├── classroom-detail.html
│   │   ├── lesson-editor.html
│   │   ├── quiz-editor.html
│   │   ├── grading.html
│   │   ├── attendance.html
│   │   ├── ai-assistant.html
│   │   └── chat.html
│   ├── student/
│   │   ├── dashboard.html
│   │   ├── classroom.html
│   │   ├── quiz.html
│   │   └── chat.html
│   └── parent/
│       └── dashboard.html
└── supabase/
    ├── migrations/
    │   └── 0001_init.sql          # كل جداول القسم 3 + RLS
    └── functions/
        └── analyze-schedule/
            └── index.ts           # Edge Function لاستدعاء Gemini
```

---

## 3. مخطط قاعدة البيانات الكامل (Supabase / PostgreSQL)

> نفّذ هذا كملف `supabase/migrations/0001_init.sql` واحد، بالترتيب التالي بالضبط (بسبب المفاتيح الأجنبية).

```sql
-- ==== ENUM TYPES ====
create type user_role as enum ('admin', 'teacher', 'student', 'parent');
create type assignment_type as enum ('hifz', 'murajaa');
create type submission_status as enum ('pending', 'done');
create type extra_assignment_type as enum ('text', 'file');
create type attendance_status as enum ('present', 'absent', 'excused');
create type session_type as enum ('halaqa', 'classroom');

-- ==== USERS ====
create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text unique not null,
  phone text,
  role user_role not null,
  is_active boolean not null default false,
  avatar_url text,
  created_at timestamptz not null default now()
);

-- ربط ولي الأمر بالطالب (علاقة متعددة إلى متعددة احتياطاً)
create table parent_student (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references users(id) on delete cascade,
  student_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(parent_id, student_id)
);

-- ==== حلقات القرآن ====
create table halaqat (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  teacher_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table halaqa_students (
  id uuid primary key default gen_random_uuid(),
  halaqa_id uuid not null references halaqat(id) on delete cascade,
  student_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(halaqa_id, student_id)
);

-- ==== المقررات اليومية ====
create table daily_assignments (
  id uuid primary key default gen_random_uuid(),
  halaqa_id uuid references halaqat(id) on delete cascade,   -- تعيين جماعي إن كانت موجودة
  student_id uuid references users(id) on delete cascade,     -- تعيين فردي إن كانت موجودة
  teacher_id uuid not null references users(id) on delete cascade,
  type assignment_type not null,
  content text not null,
  assignment_date date not null,
  created_at timestamptz not null default now()
);

create table assignment_submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references daily_assignments(id) on delete cascade,
  student_id uuid not null references users(id) on delete cascade,
  status submission_status not null default 'pending',
  teacher_notes text,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  unique(assignment_id, student_id)
);

-- ==== المواد الإضافية والفصول الافتراضية ====
create table subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique  -- 'فقه' / 'عقيدة' / 'سيرة'
);

create table classrooms (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references subjects(id),
  teacher_id uuid not null references users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table classroom_students (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references classrooms(id) on delete cascade,
  student_id uuid not null references users(id) on delete cascade,
  unique(classroom_id, student_id)
);

create table lessons (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references classrooms(id) on delete cascade,
  title text not null,
  content text,
  meet_link text,
  scheduled_at timestamptz,
  created_at timestamptz not null default now()
);

-- ==== الواجبات والاختبارات ====
create table assignments_extra (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references classrooms(id) on delete cascade,
  lesson_id uuid references lessons(id) on delete set null,
  title text not null,
  description text,
  type extra_assignment_type not null,
  due_date timestamptz,
  created_at timestamptz not null default now()
);

create table assignment_extra_submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_extra_id uuid not null references assignments_extra(id) on delete cascade,
  student_id uuid not null references users(id) on delete cascade,
  content text,
  file_url text,
  grade numeric,
  teacher_feedback text,
  submitted_at timestamptz,
  graded_at timestamptz,
  unique(assignment_extra_id, student_id)
);

create table quizzes (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references classrooms(id) on delete cascade,
  lesson_id uuid references lessons(id) on delete set null,
  title text not null,
  created_at timestamptz not null default now()
);

create table quiz_questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references quizzes(id) on delete cascade,
  question_text text not null,
  order_index int not null default 0
);

create table quiz_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references quiz_questions(id) on delete cascade,
  option_text text not null,
  is_correct boolean not null default false
);

create table quiz_submissions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references quizzes(id) on delete cascade,
  student_id uuid not null references users(id) on delete cascade,
  score numeric,
  submitted_at timestamptz not null default now(),
  unique(quiz_id, student_id)
);

create table quiz_answers (
  id uuid primary key default gen_random_uuid(),
  quiz_submission_id uuid not null references quiz_submissions(id) on delete cascade,
  question_id uuid not null references quiz_questions(id) on delete cascade,
  selected_option_id uuid references quiz_options(id)
);

-- ==== الحضور والغياب ====
create table attendance (
  id uuid primary key default gen_random_uuid(),
  session_type session_type not null,
  session_ref_id uuid not null,   -- halaqa_id أو classroom_id حسب session_type
  student_id uuid not null references users(id) on delete cascade,
  status attendance_status not null,
  attendance_date date not null,
  recorded_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  unique(session_type, session_ref_id, student_id, attendance_date)
);

-- ==== الدردشة ====
create table messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references users(id) on delete cascade,
  receiver_id uuid not null references users(id) on delete cascade,
  content text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

-- ==== الإشعارات ====
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  title text not null,
  body text,
  type text,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

-- ==== تقارير الذكاء الاصطناعي ====
create table ai_reports (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references users(id) on delete cascade,
  halaqa_id uuid references halaqat(id) on delete set null,
  report_text text not null,
  raw_data jsonb,
  created_at timestamptz not null default now()
);
```

### 3.1 سياسات الأمان (Row Level Security) — نمط عام يُطبَّق على كل جدول

```sql
-- فعّل RLS على كل الجداول
alter table users enable row level security;
alter table halaqat enable row level security;
-- ... كرّر لكل جدول أعلاه

-- مثال 1: المعلم يرى فقط حلقاته
create policy "teachers see own halaqat"
on halaqat for select
using (teacher_id = auth.uid());

create policy "teachers manage own halaqat"
on halaqat for insert with check (teacher_id = auth.uid());

create policy "teachers update own halaqat"
on halaqat for update using (teacher_id = auth.uid());

-- مثال 2: الطالب يرى فقط بياناته
create policy "students see own submissions"
on assignment_submissions for select
using (student_id = auth.uid());

-- مثال 3: الإدارة (admin) ترى كل شيء
create policy "admin full access users"
on users for select
using (
  exists (select 1 from users u where u.id = auth.uid() and u.role = 'admin')
);
```

**تعليمات للتنفيذ:** كرّر هذا النمط الثلاثي (SELECT/INSERT/UPDATE) لكل جدول حسب الدور المناسب:
- جداول `halaqat`, `daily_assignments`, `classrooms`, `lessons`, `assignments_extra`, `quizzes`, `attendance` → قصر الوصول على `teacher_id = auth.uid()` (أو عبر ربط بجدول حلقة/فصل تابع للمعلم).
- جداول `assignment_submissions`, `assignment_extra_submissions`, `quiz_submissions`, `quiz_answers` → الطالب يرى بياناته فقط (`student_id = auth.uid()`)، والمعلم يرى بيانات طلابه.
- جدول `users` → كل مستخدم يرى/يعدّل صفّه فقط، والإدارة ترى الجميع.
- جدول `messages` → `sender_id = auth.uid() OR receiver_id = auth.uid()`.
- جدول `notifications` → `user_id = auth.uid()`.

---

## 4. المصادقة والصلاحيات (Auth Flow)

1. **تسجيل معلم:** الإدارة فقط تُنشئ حساب المعلم من `admin/dashboard.html` (استدعاء `supabase.auth.admin.createUser` عبر Edge Function مخصصة، أو دعوة عبر Supabase Auth Invite) — `is_active = true` مباشرة.
2. **تسجيل طالب/ولي أمر:** نموذج عام في `register.html` → `supabase.auth.signUp()` → إدراج صف في `users` بـ `is_active = false` → توجيه لصفحة `pending-approval.html`.
3. **موافقة الإدارة:** في `admin/dashboard.html` قائمة "طلبات بانتظار الموافقة" → زر تفعيل يحدّث `is_active = true` (وإشعار للمستخدم).
4. **تسجيل الدخول:** `supabase.auth.signInWithPassword()` ثم التحقق من `role` و`is_active` من جدول `users`، والتوجيه للوحة المناسبة:
   - `admin` → `/admin/dashboard.html`
   - `teacher` → `/teacher/halaqat.html`
   - `student` → `/student/dashboard.html`
   - `parent` → `/parent/dashboard.html`
5. إذا `is_active = false` → توجيه لصفحة `pending-approval.html` بدل اللوحة.

---

## 5. مواصفات الميزات التفصيلية (Feature Specs)

### 5.1 لوحة الإدارة (`admin/dashboard.html`)
- **بطاقات إحصائية:** عدد الحلقات، عدد الطلاب، عدد المعلمين، نسبة إنجاز اليوم على مستوى المركز.
- **قسم "إنشاء معلم":** نموذج (اسم، بريد، كلمة مرور مؤقتة) → إنشاء مستخدم بدور `teacher`.
- **قسم "طلبات بانتظار الموافقة":** جدول للطلاب/أولياء الأمور غير المفعّلين، مع زري "تفعيل" و"رفض".
- **قسم "نظرة عامة على الحلقات":** جدول بكل الحلقات (اسم، المعلم، عدد الطلاب) — للعرض فقط.

### 5.2 إدارة الحلقات والمقرر اليومي (المعلم)
**الصفحات:** `teacher/halaqat.html`, `teacher/halaqa-detail.html`
- إنشاء حلقة (اسم فقط) → إدراج في `halaqat`.
- داخل تفاصيل الحلقة: إضافة/حذف طالب (بحث بالاسم أو البريد) → `halaqa_students`.
- نموذج "تعيين مقرر يومي":
  - اختيار: تعيين **جماعي** (كل طلاب الحلقة) أو **فردي** (طالب واحد).
  - نوع: حفظ أو مراجعة، محتوى نصي، تاريخ.
  - عند الحفظ الجماعي: أنشئ صفاً واحداً في `daily_assignments` بـ `halaqa_id` (بدون `student_id`)، ثم أنشئ صفاً في `assignment_submissions` لكل طالب في الحلقة بحالة `pending`.
  - عند الحفظ الفردي: أنشئ صفاً في `daily_assignments` بـ `student_id` (بدون `halaqa_id`) وصف واحد مرتبط في `assignment_submissions`.
- عرض جدول تاريخي لكل طالب: المقررات + حالتها.

### 5.3 إتمام الورد اليومي (الطالب)
**الصفحة:** `student/dashboard.html`
- عرض "ورد اليوم" (استعلام `assignment_submissions` بحالة `pending` لتاريخ اليوم).
- زر "تم الحفظ ولله الحمد" → تحديث `status = 'done'`, `submitted_at = now()`.
- مربع نص لكتابة ملاحظة الطالب (اختياري) + عرض ملاحظة المعلم إن وُجدت.

### 5.4 الفصول الافتراضية (المعلم)
**الصفحات:** `teacher/classrooms.html`, `teacher/classroom-detail.html`, `teacher/lesson-editor.html`, `teacher/quiz-editor.html`
- إنشاء فصل: اختيار مادة (فقه/عقيدة/سيرة) من `subjects` + اسم الفصل → `classrooms`.
- إضافة طلاب للفصل → `classroom_students`.
- **نشر درس:** عنوان، محتوى نصي، رابط Google Meet (اختياري)، موعد (اختياري) → `lessons`.
- **إنشاء واجب:** عنوان، وصف، نوع (نص/ملف)، موعد تسليم → `assignments_extra`.
- **إنشاء اختبار:** عنوان + أسئلة (كل سؤال: نص + 2-4 خيارات، خيار واحد صحيح) → `quizzes` + `quiz_questions` + `quiz_options`.

### 5.5 عرض الفصل وأداء الواجبات/الاختبارات (الطالب)
**الصفحات:** `student/classroom.html`, `student/quiz.html`
- قائمة الدروس (الأحدث أولاً) مع زر "انضم للاجتماع" إن وُجد `meet_link`.
- قائمة الواجبات مع حالة التسليم؛ نموذج تسليم (نص أو رفع ملف إلى Supabase Storage) → `assignment_extra_submissions`.
- أداء الاختبار: عرض الأسئلة بالترتيب، اختيار إجابة واحدة لكل سؤال → عند الإرسال:
  1. احسب الدرجة تلقائياً بمقارنة `selected_option_id` بـ `is_correct = true`.
  2. أدرج `quiz_submissions` (بالدرجة) + `quiz_answers` (لكل سؤال).
  3. اعرض النتيجة فوراً للطالب.

### 5.6 تصحيح الواجبات النصية/الملفات (المعلم)
**الصفحة:** `teacher/grading.html`
- قائمة التسليمات غير المصحّحة (`grade is null`).
- لكل تسليم: عرض المحتوى/رابط الملف، حقل درجة، حقل ملاحظات → تحديث `grade`, `teacher_feedback`, `graded_at`.

### 5.7 الحضور والغياب (المعلم)
**الصفحة:** `teacher/attendance.html`
- اختيار حلقة أو فصل + تاريخ → عرض قائمة الطلاب مع أزرار (حاضر/غائب/معذور) → إدراج/تحديث `attendance`.
- عرض تراكمي لسجل حضور كل طالب.

### 5.8 المساعد الذكي — تحليل الجداول (المعلم)
**الصفحة:** `teacher/ai-assistant.html`
- رفع ملف Excel/CSV → قراءته في المتصفح بمكتبة SheetJS وتحويله إلى JSON.
- إرسال JSON + معرّف الحلقة إلى Edge Function `analyze-schedule` (انظر القسم 6).
- عرض النتيجة: (أ) جدول المقررات المقترحة الموزّعة على التواريخ مع زر "اعتماد وحفظ" ينشئ صفوف `daily_assignments` فعلية، (ب) ملخص نصي وتوصيات من `ai_reports`.

### 5.9 الدردشة الداخلية
**الصفحات:** `teacher/chat.html`, `student/chat.html`
- قائمة محادثات (المعلم يرى كل طلابه، الطالب يرى معلمه فقط).
- إرسال رسالة → إدراج في `messages`.
- استخدام Supabase Realtime (`.channel().on('postgres_changes', ...)`) للاستماع لرسائل جديدة وعرضها فوراً بدون إعادة تحميل.

### 5.10 الإشعارات
- عند أي حدث مهم (درس جديد، واجب جديد، تصحيح، عدم إتمام الورد) → إدراج صف في `notifications` (عبر تريغر قاعدة بيانات Postgres Trigger أو مباشرة من كود الصفحة بعد كل عملية إنشاء).
- الواجهة: جرس إشعارات في كل صفحة (`js/lib/notifications.js`) يجلب `notifications` غير المقروءة عبر Realtime.
- **البريد الإلكتروني:** استخدام Supabase Database Webhook يستدعي خدمة بريد (مثل Resend عبر Edge Function) عند إدراج صف جديد في `notifications`.
- **Push:** تسجيل الاشتراك عبر `service-worker.js` + `Notification API`، وإرساله من نفس Edge Function المستخدمة للبريد.

### 5.11 ولي الأمر
**الصفحة:** `parent/dashboard.html`
- عند تسجيل الدخول: جلب كل الطلاب المرتبطين عبر `parent_student`.
- لكل طالب: عرض حالة ورد اليوم، آخر ملاحظات المعلم، درجات آخر اختبارات، سجل حضور مختصر.

### 5.12 دعم اللغتين (i18n)
- ملفا `locales/ar.json` و`locales/en.json` يحتويان كل نصوص الواجهة كمفاتيح/قيم.
- `js/lib/i18n.js`: دالة `t(key)` تُرجع النص حسب اللغة المخزّنة في `localStorage` (لا تخزين بيانات مستخدم حساسة، فقط تفضيل اللغة/الثيم).
- زر تبديل اللغة في كل صفحة يبدّل `dir` بين `rtl`/`ltr` و`lang` بين `ar`/`en` ويعيد رسم النصوص.

### 5.13 PWA
- `manifest.json`: اسم التطبيق، الأيقونات، `theme_color: #0A5C36`, `background_color: #ffffff`, `display: standalone`.
- `service-worker.js`: تخزين مؤقت (Cache) لملفات CSS/JS الأساسية + التعامل مع أحداث `push` لعرض الإشعارات.
- تسجيل الـ Service Worker في كل صفحة عبر سطر واحد في `utils.js`.

---

## 6. مواصفة Edge Function: `analyze-schedule` (Gemini Integration)

**الموقع:** `supabase/functions/analyze-schedule/index.ts`

**Input (JSON):**
```json
{
  "teacherId": "uuid",
  "halaqaId": "uuid",
  "tableData": [ { "student_name": "...", "...": "..." } ],
  "dateRange": { "from": "2026-08-01", "to": "2026-08-31" }
}
```

**منطق التنفيذ:**
1. تحقق أن `teacherId` يملك `halaqaId` فعلاً (استعلام على جدول `halaqat`).
2. ابنِ Prompt لـ Gemini يتضمن: بيانات الجدول الخام (`tableData`) وقائمة أسماء الطلاب الفعليين في الحلقة (من `halaqa_students`)، واطلب إخراج JSON فقط بالشكل:
   ```json
   {
     "assignments": [
       { "student_name": "...", "date": "YYYY-MM-DD", "type": "hifz|murajaa", "content": "..." }
     ],
     "summary": "نص ملخص قصير",
     "recommendations": ["توصية 1", "توصية 2"]
   }
   ```
3. استدعِ Gemini API من خلال Edge Function بمفتاح مخزّن في **Supabase Secrets** (`GEMINI_API_KEY`) — لا يُكتب المفتاح في الكود أبداً.
4. طابق `student_name` بمعرّفات `student_id` الحقيقية من `halaqa_students`/`users` قبل الإرجاع للواجهة.
5. احفظ `summary` + `recommendations` + البيانات الخام في `ai_reports`.
6. أعد النتيجة النهائية للواجهة الأمامية لعرضها والسماح للمعلم بـ"الاعتماد" (الذي يُنشئ صفوف `daily_assignments` الفعلية من الواجهة، وليس من داخل الدالة).

---

## 7. متغيرات البيئة / الأسرار المطلوبة (Environment Variables)

| المتغير | أين يُستخدم | ملاحظة |
|---|---|---|
| `SUPABASE_URL` | `js/lib/supabase-client.js` | عام (public) |
| `SUPABASE_ANON_KEY` | `js/lib/supabase-client.js` | عام (public) — الحماية عبر RLS فقط |
| `GEMINI_API_KEY` | Edge Function `analyze-schedule` فقط | سرّي، يُخزَّن في Supabase Secrets |
| `RESEND_API_KEY` (أو بديل بريد) | Edge Function الإشعارات | سرّي |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Functions فقط (إنشاء حسابات المعلمين، إلخ) | سرّي، لا يظهر أبداً في كود الواجهة الأمامية |

---

## 8. خطة التنفيذ المرحلية (Task Breakdown — نفّذها بالترتيب)

### المرحلة 0 — الإعداد الأساسي
- [ ] إنشاء مشروع Supabase جديد وتسجيل `SUPABASE_URL` و`SUPABASE_ANON_KEY`.
- [ ] إنشاء هيكل المجلدات كما في القسم 2.
- [ ] إعداد `index.html` أساسي يحمّل Tailwind عبر CDN وخط Amiri/Cairo من Google Fonts، ويتحقق من الألوان `#0A5C36` و`#D4AF37` في `css/style.css` كمتغيرات CSS (`--color-primary`, `--color-secondary`).
- [ ] إعداد `manifest.json` و`service-worker.js` الأساسيين (القسم 5.13).

### المرحلة 1 — قاعدة البيانات والمصادقة
- [ ] تنفيذ ملف `0001_init.sql` كاملاً (القسم 3) على Supabase.
- [ ] تفعيل RLS وكتابة كل السياسات (القسم 3.1) لكل جدول.
- [ ] بناء `js/lib/supabase-client.js` و`js/lib/auth.js`.
- [x] تعطيل التسجيل العام والاعتماد على إنشاء الحسابات المحلية من لوحة المدير.
- [ ] بناء `index.html` كصفحة تسجيل دخول فعلية + التوجيه حسب الدور (القسم 4، خطوة 4-5).

### المرحلة 2 — لوحة الإدارة
- [ ] بناء `admin/dashboard.html` + `js/pages/admin-dashboard.js` (القسم 5.1) كاملاً: الإحصائيات، إنشاء معلم، الموافقة على الحسابات.

### المرحلة 3 — الحلقات والمقرر اليومي
- [ ] بناء `teacher/halaqat.html` و`teacher/halaqa-detail.html` (القسم 5.2).
- [ ] بناء `student/dashboard.html` لعرض وإتمام ورد اليوم (القسم 5.3).

### المرحلة 4 — الفصول الافتراضية
- [ ] إدراج بيانات أولية في جدول `subjects` (فقه، عقيدة، سيرة).
- [ ] بناء `teacher/classrooms.html`, `classroom-detail.html`, `lesson-editor.html`, `quiz-editor.html` (القسم 5.4).
- [ ] بناء `student/classroom.html`, `student/quiz.html` (القسم 5.5) مع منطق التصحيح التلقائي.

### المرحلة 5 — الواجبات والتصحيح اليدوي
- [ ] بناء `teacher/grading.html` (القسم 5.6).

### المرحلة 6 — الحضور والغياب
- [ ] بناء `teacher/attendance.html` (القسم 5.7).

### المرحلة 7 — الدردشة والإشعارات
- [ ] بناء `chat.js` + صفحات الدردشة لكل دور مع Supabase Realtime (القسم 5.9).
- [ ] بناء `notifications.js` + جرس الإشعارات + Edge Function للبريد/Push (القسم 5.10).

### المرحلة 8 — المساعد الذكي (Gemini)
- [ ] كتابة وتنشر Edge Function `analyze-schedule` (القسم 6).
- [ ] بناء `teacher/ai-assistant.html` لرفع الملف وعرض النتائج واعتمادها.

### المرحلة 9 — ولي الأمر
- [ ] بناء `parent/dashboard.html` (القسم 5.11).

### المرحلة 10 — التدويل (i18n) والتلميع النهائي
- [ ] بناء `locales/ar.json`, `locales/en.json`, `i18n.js`، وتطبيقها على كل الصفحات.
- [ ] مراجعة نهائية للتصميم: الألوان، الخطوط، التجاوب (Responsive) على الجوال/الآيباد/سطح المكتب.

### المرحلة 11 — الاختبار والتسليم
- [ ] اختبار يدوي لكل دور (admin/teacher/student/parent) من التسجيل حتى إتمام دورة كاملة (حلقة → مقرر → إتمام → درس → واجب → اختبار → تصحيح → حضور → إشعار).
- [ ] التأكد من عزل بيانات كل معلم (RLS) عبر اختبار حسابين معلم مختلفين.
- [ ] اختبار تثبيت PWA على جوال حقيقي والتأكد من وصول إشعار Push تجريبي.

---

## 9. معايير القبول النهائية (Definition of Done)

- كل الأدوار الأربعة تسجّل دخول وتُوجَّه للوحتها الصحيحة.
- معلم لا يرى أي بيانات معلم آخر (تحقّق فعلي، ليس افتراضاً).
- تسجيل جماعي وفردي للمقرر اليومي يعملان ويُحدَّثان بشكل صحيح في `assignment_submissions`.
- فصل افتراضي بدرس + واجب + اختبار: يعمل بالكامل، والتصحيح التلقائي لأسئلة الاختيار صحيح رياضياً.
- الحضور والغياب يُسجَّل ويُعرض تراكمياً.
- الدردشة تعمل فورياً (Realtime) بدون تحديث الصفحة.
- رفع ملف Excel وتحليله عبر Gemini يُنتج مقترحات صحيحة قابلة للاعتماد.
- الإشعارات تصل داخل التطبيق + بريد + Push فعلياً عند حدوث الأحداث المحددة.
- التطبيق قابل للتثبيت كـ PWA على جوال Android/iOS.
- التبديل بين العربية والإنجليزية يعمل فورياً ويغيّر اتجاه الصفحة (RTL/LTR).
