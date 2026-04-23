@echo off
cd /d "C:\Users\ryan.bass\et-office-portal\scripts"

echo =====================================
echo ET IMPORT STARTED %DATE% %TIME%
echo =====================================

node import-customers.mjs
if errorlevel 1 pause

node importCustomersWithBuyerEmail.mjs
if errorlevel 1 pause

node import-invoices-last-3-years.mjs
if errorlevel 1 pause

node import-items-master.mjs
if errorlevel 1 pause

node import-open-sales-orders.mjs
if errorlevel 1 pause

node backfill_line_headers.mjs
if errorlevel 1 pause

node build_item_customer_index.mjs
if errorlevel 1 pause

node computeTopItems60d.mjs
if errorlevel 1 pause

node pull_prospects_osm_city.mjs
if errorlevel 1 pause

node pull_prospects_from_hubs.mjs
if errorlevel 1 pause

node process_prospects_raw.mjs
if errorlevel 1 pause

node rank_prospects_by_hub.mjs
if errorlevel 1 pause

echo =====================================
echo ET IMPORT COMPLETE %DATE% %TIME%
echo =====================================
pause