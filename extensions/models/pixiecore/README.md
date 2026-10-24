# @svendowideit/pixiecore

Run pixiecore as a managed container, auto-configured to serve netboot.xyz to any host that netboots on the LAN.

## What it does

Runs the pixiecore container in `quick xyz` mode (netboot.xyz menu) as a
long-lived service through @svendowideit/container-service. The container uses
the host network stack (`--network host`) and listens on 0.0.0.0. Install and
start it once and any host booting from the network gets the netboot.xyz menu.

## Install

    swamp extension pull @svendowideit/pixiecore

## Configuration

Global arguments: image, containerName, serviceBackend, binary, listenAddr,
httpPort, statusPort, dhcpNoBind, debug, restart.

## Examples

Create the model and start the container (single `--net host` container):

    swamp model create @svendowideit/pixiecore pixie --global-arg binary=docker
    swamp model method run pixie ensure

Inspect it:

    swamp model method run pixie status

Remove it:

    swamp model method run pixie remove

The whole flow can be re-run with `swamp model method run pixie ensure` after
editing any global argument.

## Details

Model: pixiecore. Methods: ensure, start, serve, run, status, remove.
Resources: ensureResult, statusResult, removeResult.
Dependencies: @svendowideit/container-service.

## Upgrade

    swamp extension update
