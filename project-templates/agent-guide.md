When the person asks to run a Review Bridge work order ({{file}}):

1. Tell them to run this in a terminal window, in this project folder:

       review-bridge start {{file}}

   It plans the work, checks that the reviewer can only read, shows what the work will be
   allowed to do, and asks "Start this work? [y/N]".
2. Do not run `review-bridge start` yourself and never answer its question: only the person
   authorizes the work. It needs a real terminal and refuses to run without one, so an agent's
   shell cannot start it. Do not use --yes, --approve or piped input.
3. Wait until the person says it has finished. Then read the result file it printed
   ("Result file: ...") and summarize it for them.
4. Do not commit, push, deploy or release anything unless the person asks you to.
