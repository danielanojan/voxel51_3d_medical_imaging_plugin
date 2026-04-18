import { PluginComponentType, registerComponent } from "@fiftyone/plugins";
import { BratsAxialPanel, BratsCoronalPanel, BratsSagittalPanel } from "./BratsSlicePanel";

registerComponent({
  name: "BratsAxialViewer",
  label: "BraTS Axial",
  component: BratsAxialPanel,
  type: PluginComponentType.Panel,
  activator: () => true,
});

registerComponent({
  name: "BratsCoronalViewer",
  label: "BraTS Coronal",
  component: BratsCoronalPanel,
  type: PluginComponentType.Panel,
  activator: () => true,
});

registerComponent({
  name: "BratsSagittalViewer",
  label: "BraTS Sagittal",
  component: BratsSagittalPanel,
  type: PluginComponentType.Panel,
  activator: () => true,
});
