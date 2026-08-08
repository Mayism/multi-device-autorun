import { ConfigurationConstant } from '@kit.AbilityKit';

@ObservedV2
export class ColorModeClass {
  @Trace currentMode: ConfigurationConstant.ColorMode | undefined = ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
}