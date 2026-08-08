import { UserInfoForm } from 'login';

@Builder
export function UserInfoPageBuilder() {
  UserInfoPageHost();
}

@ComponentV2
struct UserInfoPageHost {
  @Consumer('appPathStack') appPathStack: NavPathStack = new NavPathStack();

  build() {
    NavDestination() {
      UserInfoForm();
    }
    .title('个人信息')
    .onBackPressed(() => {
      this.appPathStack.pop();
      return true;
    });
  }
}
