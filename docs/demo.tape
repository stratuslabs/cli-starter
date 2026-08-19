# A terminal recording of the parts a screenshot cannot show.
#
# Rendered with charmbracelet/vhs — https://github.com/charmbracelet/vhs
#
#   brew install vhs        # or: go install github.com/charmbracelet/vhs@latest
#   vhs docs/demo.tape      # writes docs/demo.gif
#
# Checked in rather than only the GIF so it can be re-rendered when the output
# changes, instead of quietly showing a version of the CLI that no longer
# exists. Regenerate it when you change the demo commands or the theme.

Output docs/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1000
Set Height 640
Set Padding 18
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

# --- help, derived from the registry --------------------------------------
Type "npm run acme -- --help"
Enter
Sleep 2.5s

Type "clear"
Enter
Sleep 300ms

# --- the arrow-key menu, which is the thing worth seeing ------------------
Type "npm run acme -- demo prompts"
Enter
Sleep 2s
Down
Sleep 500ms
Down
Sleep 500ms
Up
Sleep 700ms
Enter
Sleep 1.5s

Type "clear"
Enter
Sleep 300ms

# --- output a script can use ----------------------------------------------
Type "npm run acme -- demo output"
Enter
Sleep 2.5s

Type "npm run acme -- demo output --json | head -12"
Enter
Sleep 2.5s

# --- an error that says what to do ----------------------------------------
Type "npm run acme -- demo error --kind auth; echo \"exit: $?\""
Enter
Sleep 3s
