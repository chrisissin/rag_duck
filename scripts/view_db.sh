#!/bin/bash
# Helper script to view database contents

echo "=== Database Summary ==="
docker exec -i slack_rag_pg psql -U postgres -d slack_rag -c "
SELECT 
  channel_name, 
  COUNT(*) as chunks, 
  SUM(message_count) as total_messages,
  COUNT(*) FILTER (WHERE is_thread) as threads,
  COUNT(*) FILTER (WHERE NOT is_thread) as windows
FROM slack_chunks 
GROUP BY channel_name;
"

echo ""
echo "=== Sample Chunks (Latest 5) ==="
docker exec -i slack_rag_pg psql -U postgres -d slack_rag -c "
SELECT 
  id, 
  channel_name, 
  CASE WHEN is_thread THEN 'Thread' ELSE 'Window' END as type,
  message_count, 
  LEFT(text, 80) || '...' as text_preview
FROM slack_chunks 
ORDER BY created_at DESC 
LIMIT 5;
"

echo ""
echo "=== Sample Thread Details ==="
docker exec -i slack_rag_pg psql -U postgres -d slack_rag -c "
SELECT 
  id,
  channel_name,
  thread_ts,
  message_count,
  LENGTH(text) as text_length,
  start_ts,
  end_ts
FROM slack_chunks 
WHERE is_thread = true
ORDER BY message_count DESC
LIMIT 3;
"

