UPDATE public.inbound_emails
SET status='received', error=NULL, created_record_type=NULL, created_record_id=NULL, processed_at=NULL
WHERE status='classified';