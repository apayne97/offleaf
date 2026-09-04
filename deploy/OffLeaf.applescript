-- OffLeaf launcher (on-demand, no background service).
--
-- Double-clicking the compiled app starts the local backend if it isn't
-- already running, waits for it to come up, then opens it in your browser.
-- If you've installed OffLeaf as a standalone window (Chrome/Edge -> ... ->
-- "Install page as app..." while on http://127.0.0.1:3000), that's what
-- opens; otherwise it's a normal browser tab.
--
-- Build:
--   cd ~/science/offleaf
--   osacompile -o "OffLeaf.app" deploy/OffLeaf.applescript
--
-- Then drag OffLeaf.app to ~/Applications (or /Applications, or the Dock)
-- wherever you'd like to launch it from.
--
-- Logs from a launcher-started server: /tmp/offleaf-launcher.log

property offleafDir : (POSIX path of (path to home folder)) & "science/offleaf"
property offleafURL : "http://127.0.0.1:3000"

on isServerUp()
	try
		set code to do shell script "curl -s -o /dev/null -w '%{http_code}' " & offleafURL & " --max-time 2"
		return code is "200"
	on error
		return false
	end try
end isServerUp

if not isServerUp() then
	do shell script "cd " & quoted form of offleafDir & ¬
		" && export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" & ¬
		" && nohup npm start > /tmp/offleaf-launcher.log 2>&1 &"
	repeat 15 times
		delay 1
		if isServerUp() then exit repeat
	end repeat
end if

open location offleafURL
