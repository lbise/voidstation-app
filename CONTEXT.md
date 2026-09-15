# Voidstation

Voidstation is a personal hub for monitoring and controlling the Ubuntu server hosted at home.

## Language

**Server**:
The home Ubuntu machine that Voidstation manages, distinct from the Voidstation application itself.
_Avoid_: Backend

**Dashboard**:
The view of the server's resource usage and status within Voidstation.

**Disk space**:
The capacity, used space, and available space of a mounted filesystem on the server. It does not describe a physical disk's health or raw capacity.

**Uptime**:
The time elapsed since the server booted, not since Voidstation or its container started.

**Stale reading**:
A previously successful server measurement retained for display after refreshing it fails. It is historical information, not a statement of the server's current state.

## Assistant and media

**Assistant**:
Voidstation's conversational interface for requesting server tasks through explicitly enabled capabilities.

**Assistant skill**:
An owner-installed set of instructions and supporting resources for a task the assistant can perform. Installing a skill does not itself grant permission to execute every action it describes.

**Action approval**:
The owner's authorization for a specific proposed media action, including its titles, season scope, and quality changes. It does not authorize actions with different parameters or future requests.

**Media request**:
An instruction to add a movie or TV series to the managed library, monitor it, and search for a downloadable release. It does not imply that a download has started or that the title is ready to watch.

**Managed library**:
The movies tracked by Radarr and the TV series tracked by Sonarr, including titles whose files are not yet available.

**Monitoring**:
A title's eligibility for automatic release acquisition by Radarr or Sonarr. It is distinct from monitoring the server's resource usage in the dashboard.

**Download search**:
A request for Radarr or Sonarr to look for an eligible release. An accepted search is not evidence that a download has started.
