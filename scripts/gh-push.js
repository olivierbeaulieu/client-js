const { exec, echo } = require("shelljs")
const { githubPushUrl, exitOnError } = require("./helpers")

echo("Pushing code and tags...")

exitOnError(() => {
  exec(`git push "${githubPushUrl()}" --follow-tags`)
})

echo("Pushed branch & tags")