# Run from the repository root if videos/build files ever show up in Source Control.
# This keeps the files on your computer but removes them from Git tracking.

git rm -r --cached apps/api/storage 2>$null
git rm -r --cached apps/web/.next 2>$null
git rm -r --cached apps/web/node_modules 2>$null
git rm -r --cached .venv 2>$null
git rm --cached apps/api/volleyvision.db 2>$null
git add .gitignore scripts/clean-git-generated-files.ps1
Write-Host "Done. Now run: git commit -m 'Stop tracking generated files' && git push"
