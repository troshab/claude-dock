# claude-dock sandbox template
# Based on docker/sandbox-templates:shell (Ubuntu 25.10 + dev tools + socat).
# Adds: Claude Code CLI, entrypoint for path symlinks + port forwarding.

FROM docker/sandbox-templates:shell

# Install Claude Code as agent user
USER agent
RUN set -ex && curl -fsSL https://claude.ai/install.sh | bash

# Entrypoint: path fixup, orphan cleanup, port forwarding, then exec "$@"
USER root
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER agent
ENV CLAUDE_ENV_FILE=/etc/sandbox-persistent.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["claude", "--dangerously-skip-permissions"]
