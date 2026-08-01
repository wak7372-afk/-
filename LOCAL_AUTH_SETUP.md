# إعداد الحسابات المحلية

## ما الذي تغير؟

- المستخدم يسجل الدخول باسم مستخدم وكلمة مرور، وليس بالبريد الإلكتروني.
- المدير ينشئ حسابات الطلاب والمعلمين وأولياء الأمور من لوحة الإدارة.
- تحفظ Supabase بريداً تقنياً داخلياً للحساب الجديد، ولا يظهر في واجهات المنصة.
- يجب على مالك الحساب تغيير كلمة المرور الأولية عند أول دخول.
- يمكن لصاحب الحساب ربط Google من صفحة "حسابي"، ثم استخدام Google لإثبات هويته عند إعادة ضبط كلمة المرور.

## النشر على Supabase

> قبل النشر: نفّذ قائمة الأمان في `SECURITY.md`، وأنشئ المدير وفق `ADMIN_BOOTSTRAP.md`. لا تستخدم أي كلمة مرور كانت موجودة في migration قديم.

1. نفذ migration جديد قاعدة البيانات:

   \`\`\`powershell
   supabase db push
   \`\`\`

2. انشر دوال Edge:

   \`\`\`powershell
   supabase functions deploy login-with-username --no-verify-jwt
   supabase functions deploy admin-create-account
   supabase functions deploy account-recovery --no-verify-jwt
   supabase functions deploy analyze-schedule
   \`\`\`

   واضبط الأسرار المطلوبة، ومنها `APP_ORIGIN` و`GEMINI_API_KEY`، عبر Supabase Secrets وليس داخل الملفات.

3. في Supabase Dashboard، فعّل مزود Google وأضف عناوين العودة الفعلية للموقع:

   - \`https://YOUR-DOMAIN/account-settings.html\`
   - \`https://YOUR-DOMAIN/reset-password.html\`

4. انشر كذلك `account-recovery` و`analyze-schedule` قبل اختبار الاستعادة والمساعد الذكي.
5. فعّل Manual Identity Linking في إعدادات Authentication. هذا مطلوب لزر "ربط حساب Google".

## استرداد كلمة المرور عبر OTP

- يجب أن يكون حساب Google مرتبطاً بالحساب المحلي من صفحة "حسابي".
- دالة `account-recovery` تتحقق من هوية Google المرتبطة، ثم تنشئ رمزاً من ستة أرقام صالحاً لعشر دقائق.
- لا يُخزّن الرمز بصورته الأصلية؛ يُخزّن hash فقط مع حد أقصى للمحاولات.
- إرسال البريد يتم عبر Resend من Edge Function، ولا يظهر مفتاح البريد في JavaScript.
- اضبط `APP_ORIGIN`, `RESEND_API_KEY`, و`RESEND_FROM_EMAIL` في أسرار Supabase قبل نشر الدالة.

إذا لم يكن مزود البريد مضبوطاً، ترفض الدالة الاستعادة بدلاً من إظهار نجاح وهمي.
