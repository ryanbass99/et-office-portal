@echo off
cd /d "C:\Users\ryan.bass\et-office-portal\scripts"

echo =====================================
echo ET IMPORT STARTED %DATE% %TIME%
echo =====================================

node import-customers.mjs
if errorlevel 1 goto :failed

node importCustomersWithBuyerEmail.mjs
if errorlevel 1 goto :failed

node import-invoices-last-3-years.mjs
if errorlevel 1 goto :failed

node import-items-master.mjs
if errorlevel 1 goto :failed

node import-open-sales-orders.mjs
if errorlevel 1 goto :failed

node build_item_customer_index.mjs
if errorlevel 1 goto :failed

node computeTopItems60d.mjs
if errorlevel 1 goto :failed

node pull_prospects_osm_city.mjs
if errorlevel 1 goto :failed

node pull_prospects_from_hubs.mjs
if errorlevel 1 goto :failed

node process_prospects_raw.mjs
if errorlevel 1 goto :failed

node rank_prospects_by_hub.mjs
if errorlevel 1 goto :failed

echo =====================================
echo ET IMPORT COMPLETE %DATE% %TIME%
echo =====================================
exit /b 0

:failed
set "IMPORT_EXIT_CODE=%ERRORLEVEL%"
echo =====================================
echo ET IMPORT FAILED %DATE% %TIME%
echo Exit code: %IMPORT_EXIT_CODE%
echo =====================================
exit /b %IMPORT_EXIT_CODE%
