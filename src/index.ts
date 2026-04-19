import { PluginComponentType, registerComponent } from "@fiftyone/plugins";
import { BratsPanel } from "./BratsSlicePanel";

registerComponent({
  name: "BratsSliceViewer",
  label: "BraTS Slice Viewer",
  component: BratsPanel,
  type: PluginComponentType.Panel,
  activator: () => true,
});
