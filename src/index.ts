import { PluginComponentType, registerComponent } from "@fiftyone/plugins";
import { BratsSlicePanel } from "./BratsSlicePanel";

registerComponent({
  name: "BratsSliceViewer",
  label: "BraTS Slice Viewer",
  component: BratsSlicePanel,
  type: PluginComponentType.Panel,
  activator: () => true,
});
