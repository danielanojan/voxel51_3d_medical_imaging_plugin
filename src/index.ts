import { PluginComponentType, registerComponent } from "@fiftyone/plugins";
import { BratsPanel } from "./BratsSlicePanel";

registerComponent({
  name: "NiftiSliceViewer",
  label: "NIfTI Slice Viewer",
  component: BratsPanel,
  type: PluginComponentType.Panel,
  activator: () => true,
});
