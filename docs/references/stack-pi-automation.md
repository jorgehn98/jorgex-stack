# Coordinación Stack ↔ Pi retirada

El coordinador automático de snapshots y el preparador de adopciones están retirados, sin sustituto. Los cambios entre repositorios se tramitan mediante PRs explícitas y merge autorizado.

Las variables y credenciales de la antigua automatización ya no activan ningún workflow en Stack. Mientras Pi conserve su notificador, sus eventos `pi-published-v1` no tienen un consumidor en este repositorio. No reejecutar publicaciones para intentar recuperar esa coordinación.

Esta retirada no modifica instalaciones personales ni el lifecycle local de Pi. La publicación de Stack y la validación de artefactos continúan por sus workflows existentes; véase [Pi runtime](pi-runtime.md).
