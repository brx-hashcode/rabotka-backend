-- In-app advertisement delivery: the ad is dropped into the web client as a
-- dismissible popup instead of being sent over email/WhatsApp. Placed before
-- 'ALL' so the enum reads EMAIL, WHATSAPP, IN_APP, ALL; 'ALL' keeps meaning
-- email + WhatsApp only, so existing bundles do not start pushing popups.
ALTER TYPE "DeliveryChannel" ADD VALUE IF NOT EXISTS 'IN_APP' BEFORE 'ALL';
