; Установщик DotLink: правило брандмауэра, чтобы телефон достучался до ПК в частных и общественных сетях.
; Ставится один раз (установка идёт с правами администратора), удаляется вместе с программой.
!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="DotLink"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="DotLink" dir=in action=allow program="$INSTDIR\DotLink.exe" enable=yes profile=private,domain,public'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="DotLink"'
!macroend
